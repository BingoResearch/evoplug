/**
 * `@evoplug/evidence` public surface (DD-EVD-026).
 *
 * Domain modules: frozen evidence index, pack compiler, dependency closure,
 * shard planning, omission, budget estimation, service profiles, judge
 * bindings, typed/categorical validation, gateway, aggregation, persistence
 * and recovery.
 */

export * from "./types.js";
export * from "./errors.js";
export * from "./semantic-backend-transport.js";
export * from "./hashing.js";

export {
  EvidenceIndexPortError,
  evidenceIndexPortError,
  assertBindingScope,
  type EvidenceIndexPortErrorCode,
  type EvidenceIndexPortErrorShape,
} from "./evidence-index-port.js";

export {
  createEvidenceIndexSnapshot,
  isEvidenceIndexSnapshot,
  computeSnapshotHash,
  snapshotRowsProjection,
  type EvidenceIndexSnapshotData,
  type FrozenSourceRecord,
} from "./evidence-index-snapshot.js";

export {
  createEvidenceIndexSnapshotLoader,
} from "./evidence-snapshot-loader.js";

export {
  compileEvidencePack,
  createEvidenceCompiler,
  type EvidencePlanReadPort,
  type EvidenceIssueReadPort,
  type PackCompilerDeps,
} from "./pack-compiler.js";

export { expandDependencyClosure } from "./dependency-closure.js";

export {
  estimateBudget,
  estimateBudgetForShard,
  estimateSemanticBudget,
  registerShardBudgetMetrics,
  shardBudgetMetrics,
  type ShardBudgetMetrics,
} from "./budget-estimator.js";

export { planShardsForPlan } from "./shard-planner.js";

export {
  buildJevServiceProfile,
  buildJevServiceState,
  buildJevValidatorBinding,
  buildSemanticBackendCapability,
  buildSemanticValidationBinding,
  evaluateJevAcceptance,
  assertServiceStateConsistent,
  resolveDispatchProfile,
  semanticScopeKey,
  jevServiceStateKey,
  type JevServiceProfileBody,
  type JevServiceProfileInput,
  type SemanticCapabilityInput,
} from "./service-profile.js";

export {
  buildJudgeRequest,
  buildTemplateBindings,
  questionBindingFor,
  backendRefOf,
  type BuildRequestContext,
  type SemanticQuestionOptions,
} from "./judge-binding.js";

export {
  validateTypedWire,
  validateCategoricalOutput,
  semanticOutputInvalidError,
  normalizedAnswerTextHash,
  PROBABILITY_SUM_TOLERANCE,
  CONFIDENCE_TOLERANCE,
  CHOICE_OPTIONS_MIN,
  CHOICE_OPTIONS_MAX,
  SCORE_LEVELS_MIN,
  SCORE_LEVELS_MAX,
  type TypedValidationResult,
  type CategoricalValidation,
  type CategoricalValidationFailure,
  type CategoricalValidationSuccess,
  type CategoricalReason,
} from "./jev-validator.js";

export {
  createJudgeGateway,
  createJudgeService,
  type JudgeGatewayDeps,
  type JudgeService,
  type JudgeServiceInput,
  type GatewayLateStore,
  type GatewayAttemptPersistence,
} from "./jev-gateway.js";

export {
  reduceAggregate,
  createAnswerAggregator,
  createAcceptedAggregateReader,
  type EnvelopeObjectReadPort,
  type ExtendedAnswerAggregatorDeps,
  type ReductionEnvelope,
  type ReduceInputV2,
  type ReduceInputV1,
  type HardFactReductionInput,
} from "./aggregator.js";

export {
  createEvdStateWriter,
  storeContent,
  sourceBlobRefsOf,
  collectBlobRefs,
  buildPackRows,
  buildUnitRows,
  buildManifestRows,
  buildShardPlanRows,
  buildOmissionRows,
  buildEstimateRows,
  toLiveOutcome,
  EVD_ROW_REDUCERS,
  shardTransitionAllowed,
  attemptTransitionAllowed,
  type EvdRowSchema,
  type EvdRowWrite,
  type EvdAppendRequest,
  type EvdCommitOutcome,
  type EvdAppendReceipt,
  type EvdStateRowPort,
  type EvdJudgeStateDocument,
  type EvdStateDocumentWritePort,
  type EvdBlobWritePort,
  type EvdStoredBlob,
  type EvdWriterDeps,
  type EvdReduceContext,
  type EvdRowReducer,
} from "./store.js";

export {
  recoveryDecision,
  replayMembers,
  type RecoverySituation,
  type RecoveryDecision,
  type ReplayMember,
} from "./recovery.js";

export {
  EVIDENCE_INDEX_LOAD_DEADLINE_MS,
  MAX_SOURCE_BYTES,
  MAX_TOTAL_FROZEN_BYTES,
  MAX_INDEX_SOURCE_REFS,
  MAX_INDEX_ROWS,
  MAX_EXCERPT_BYTES,
  MAX_EVD_OBJECT_BYTES,
  MAX_PROGRESS_CHECKPOINTS,
  MAX_PROGRESS_WATERMARK_SPAN,
  DEFAULT_CONFLICT_RETRIES,
  COMPILER_VERSION,
  COUNTING_METHOD_VERSION,
  SOURCE_MANIFEST_VERSION,
  SHARD_POLICY_VERSION,
  AGGREGATION_POLICY_VERSION,
  AGGREGATION_POLICY_VERSION_V1,
  REVIEW_POLICY_VERSION,
  SEMANTIC_VALIDATOR_POLICY_VERSION,
  JEV_VALIDATOR_POLICY_VERSION,
} from "./types.js";
export * from "./binding-reader.js";
