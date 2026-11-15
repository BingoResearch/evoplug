/**
 * `@evoplug/adapter-step-code` public surface.
 *
 * The package implements the HOST-owned `HostAdapter` port (DD-HOST-001) for
 * Step Code (DD-HOST-030, DD-HOST-100). It exports the frozen descriptor, the
 * event contract table, the normalizer, the adapter class and the
 * identity/version facts.
 */

export type * from "./contract.js";
export { adapterErr, adapterOk } from "./contract.js";

export {
  StepCodeHostAdapter,
  createStepCodeHostAdapter,
  computeCapabilityBindingKey,
  isStepHostEventBinding,
  isProbeableCapability,
  type StepDeliveryBridgePort,
  type StepDeliverySubmitInput,
  type StepDeliverySubmitResult,
  type StepHostAdapterOptions,
  type StepRegistrationApplyInput,
  type StepRegistrationApplyResult,
  type StepRegistrationWriterPort
} from "./adapter.js";

export {
  STEP_ADAPTER_DESCRIPTOR,
  STEP_CONFIG_SPACES,
  STEP_DESCRIPTOR_HASH,
  STEP_DESCRIPTOR_REF,
  STEP_REGISTRATION_TARGETS,
  STEP_SUPPORTED_MODES,
  computeDescriptorHash,
  computeRegistrationHash,
  describeStepAdapter,
  descriptorToJson,
  isStepConfigSpace,
  isStepMode,
  isStepStdioMode,
  stepConstructionPathForMode,
  stepRegistrationTarget,
  validateAdapterDescriptor,
  type RegistrationHashFields
} from "./descriptor.js";

export {
  STEP_EVENT_CONTRACTS,
  STEP_EVENT_NAMES,
  STEP_EXTENSION_EVENTS,
  STEP_OBSERVATION_EVENTS,
  STEP_STDIO_EVENTS,
  isStepObservationEvent,
  isStepStdioEvent,
  stepAsyncWorkUnknown,
  stepCanonicalKinds,
  stepEventContract,
  stepInputOriginUnknown,
  stepQueueEmptyUnknown,
  stepRequiredCapabilities,
  stepRetryStateUnknown
} from "./events.js";

export {
  HOST_RESERVED_CAPABILITY,
  STEP_CAPABILITY_NAMES,
  STEP_DECLARED_CAPABILITIES,
  hasStaticAdapterEvidence,
  isCapabilityName
} from "./capabilities.js";

export {
  STEP_ADAPTER_ID,
  STEP_ADAPTER_VERSION,
  STEP_ARCHIVE_SHA256,
  STEP_HOST_ID,
  STEP_HOST_VERSION,
  STEP_IMPLEMENTATION_FILES,
  STEP_IMPLEMENTATION_HASH,
  STEP_INSTALL_PATH,
  STEP_SOURCE_COMMIT,
  STEP_SOURCE_VERSION,
  STEP_TOOLCHAIN,
  STEP_VERSION_FACTS,
  computeImplementationHash,
  type AdapterManifestFile,
  type AdapterManifestInput
} from "./manifest.js";

export { normalizeStepEvent } from "./normalize.js";

export { STEP_UNKNOWN_REASON, stepUnknown, type StepUnknownReason } from "./facts.js";

export { STEP_REGISTRATION_ARTIFACT } from "./registration.js";

export { STEP_GENERATION_SPEC } from "./generation-spec.js";

export { stepCodeProbeSpec } from "./probe-spec.js";

export * from "./compaction-spec.js";
