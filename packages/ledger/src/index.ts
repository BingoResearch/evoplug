/**
 * @evoplug/ledger public surface (FND 5).
 *
 * Domains: identity/fork/resume, requirement ops and as-of projection,
 * facts and verifications, feedback, ledger corrections, success evidence and
 * TaskOutcome. All writes go through the FND state-row port; SQL is never
 * issued from this package.
 */

export type {
  DirectiveStrength,
  HumanAttestation,
  HumanAttestationKind,
  Origin,
  OriginBasis,
  RequirementOpKind,
  RequirementOpStatus,
  TaskOutcome,
  TriggerAxis,
  TriggerLineage,
  TruthState,
} from "./domain/common.js";

export type {
  AcceptanceCriterion,
  CurrentRequirement,
  LedgerRequirementOpRow,
  LedgerRequirementRow,
  RecordRequirementOpsRequest,
  RecordRequirementOpsResult,
  RequirementOpDraft,
  RequirementOpRecord,
  RequirementOpResult,
  RequirementScope,
  RequirementWritePort,
  UnverifiedConstraint,
  UnverifiedConstraintDraft,
} from "./domain/requirements.js";

export type {
  FactListQuery,
  FactReadPort,
  FactVerificationEffect,
  FactVerificationRecordedPayload,
  FactVerificationRecordedPayloadV1,
  FactVerificationRecordedPayloadV2,
  FactVerificationStatus,
  StateFactDraft,
  StateFactKind,
  StateFactView,
  VerifyFactRequest,
  VerifierKind,
  VerifierListQuery,
  VerifierRegistryPort,
  VerifierRegistryView,
  VerifierResult,
} from "./domain/facts.js";
export { STATE_FACT_KINDS, VERIFIER_KINDS } from "./domain/facts.js";

export type {
  CorrectionKind,
  FeedbackDraft,
  FeedbackKind,
  FeedbackRecord,
  LedgerCorrection,
  LedgerCorrectionDraft,
  LedgerFeedbackRow,
} from "./domain/feedback.js";

export type {
  ActiveRequirement,
  EvidenceLedgerReadPort,
  EvidenceLedgerReadQuery,
  ExplicitLifecycleEvent,
  LedgerEvidenceSnapshot,
  LedgerView,
  PendingWorkItem,
  PendingWorkKind,
  RecordSuccessEvidenceRequest,
  SuccessEvidence,
  SuccessEvidenceKind,
  SuccessEvidencePort,
  SuccessEvidenceProducerKind,
  SuccessEvidenceView,
  TaskOutcomeEvaluationInput,
  TaskOutcomeRecord,
} from "./domain/outcome.js";

export type {
  BranchCandidate,
  BranchForkResult,
  ForkIdempotencyRecord,
  ForkRequest,
  ForkSourceBranch,
  IdentityResolution,
  IdentityResolveInput,
  IdentityState,
  NativeSessionMapping,
  ResumeObservation,
  ResumeResult,
} from "./domain/identity.js";

export {
  ledgerError,
  ledgerFailure,
  ledgerOk,
  ledgerNoOp,
  schemaError,
  asofUnavailable,
  versionBindingError,
  watermarkAheadError,
  idempotencyConflict,
  sourceRefInvalid,
  sourceNotFound,
  sourceHashError,
  sourceUtf8Error,
} from "./errors.js";
export type { LedgerErrorCode, LedgerErrorInput, LedgerFailureStatus } from "./errors.js";

export {
  isSortedUniqueStrings,
  isSafeRelativePath,
  parseJsonValue,
  stringSetsEqual,
  uniqueSortedStrings,
  utf8ByteLength,
} from "./util.js";
export { sha256Bytes, sha256Utf8, isHash, hashEquals } from "./raw-hash.js";
export { isSourceRef, parseSourceRef } from "./source-ref.js";

export {
  equalVersionBindings,
  factVisibleUnder,
  sameTaskBranch,
  validateVersionBinding,
} from "./validation.js";

export {
  constraintsViewHash,
  evidenceSnapshotViewHash,
  factVerificationContentHashV1,
  factVerificationContentHashV2,
  goalSnapshotHash,
  ledgerCorrectionHash,
  ledgerViewHash,
  requirementContentHash,
  requirementOpContentHash,
  sortPendingWork,
  stateFactContentHash,
  successEvidenceHash,
  taskOutcomeHash,
} from "./hashes.js";
export type {
  FactVerificationContentHashV2Input,
  GoalSnapshotHashInput,
  LedgerCorrectionHashInput,
  RequirementContentHashInput,
  RequirementOpContentHashInput,
  SuccessEvidenceHashInput,
  TaskOutcomeHashInput,
} from "./hashes.js";

export type { JsonObject } from "./json.js";
export {
  acceptanceCriterionJson,
  acceptanceListJson,
  currentRequirementJson,
  feedbackRecordJson,
  humanAttestationJson,
  ledgerCorrectionJson,
  ledgerEvidenceSnapshotJson,
  ledgerFeedbackRowJson,
  ledgerRequirementOpRowJson,
  ledgerRequirementRowJson,
  ledgerViewJson,
  methodRefJson,
  pendingWorkJson,
  requirementOpDraftJson,
  requirementOpRecordJson,
  requirementScopeJson,
  stateFactDraftJson,
  stateFactViewJson,
  successEvidenceJson,
  taskOutcomeRecordJson,
  triggerLineageJson,
  unverifiedConstraintJson,
  verifierRegistryViewJson,
  versionBindingJson,
} from "./json.js";

export type {
  FactVerificationStateRow,
  FeedbackStateRow,
  GoalSnapshotStateRow,
  LedgerCorrectionStateRow,
  RequirementHeadStateRow,
  RequirementOpStateRow,
  RequirementSourceStateRow,
  RequirementStateRow,
  StateFactStateRow,
  SuccessEvidenceStateRow,
  TaskOutcomeStateRow,
  UnverifiedConstraintStateRow,
} from "./rows.js";

export type {
  HumanProofPurpose,
  HumanProofVerdict,
  LedgerAppendReceipt,
  LedgerAppendRequest,
  LedgerBlobWritePort,
  LedgerBranchView,
  LedgerClockPort,
  LedgerCommitOutcome,
  LedgerEventLogPort,
  LedgerGoalSnapshotQuery,
  LedgerIdentityReadPort,
  LedgerPorts,
  LedgerProjectionReadPort,
  LedgerRequirementReadQuery,
  LedgerReservationReadPort,
  LedgerReservationView,
  LedgerSessionView,
  LedgerSourceEvent,
  LedgerStateRowKey,
  LedgerStateRowOperation,
  LedgerStateRowPort,
  LedgerStateRowReadPort,
  LedgerStateRowReadQuery,
  LedgerStateRowSchema,
  LedgerStateRowSnapshot,
  LedgerStateRowWrite,
  LedgerStoredText,
  LedgerVerificationCommitPort,
  OriginProofPort,
  VerificationCommitInput,
} from "./ports.js";

export type { LedgerRowSchema } from "./ledger-row-schema.js";
export { LEDGER_ROW_SCHEMAS, isLedgerRowSchema } from "./ledger-row-schema.js";

export { isResolved, resolveIdentity } from "./identity/resolve.js";
export { isSameForkRequest, planBranchFork } from "./identity/fork.js";
export type {
  ForkAuditDecision,
  ForkPlan,
  ForkPlanInput,
  ForkSeedInput,
  InheritedRequirementRef,
} from "./identity/fork.js";
export { missingRanges, planResume, resumeStartsNewEpoch, sortCandidatesByBranch } from "./identity/resume.js";
export type { ResumeAuditDecision, ResumePlan, ResumePlanInput } from "./identity/resume.js";

export {
  acceptanceSortKey,
  buildRequirementOpRecord,
  determineRequirementOpStatus,
  isSortedAcceptance,
  planRequirementGoalTransition,
  REQUIREMENT_OP_KINDS,
  REQUIREMENT_OP_STATUSES,
  REQUIREMENT_SCOPE_MODES,
  sortAcceptance,
  validateAcceptanceList,
  validateRequirementOpDraft,
  validateRequirementScope,
} from "./requirements/ops.js";
export type {
  BuildRequirementOpRecordInput,
  RequirementGoalTransition,
  RequirementGoalTransitionInput,
  RequirementOpStatusContext,
  RequirementOpValidationContext,
} from "./requirements/ops.js";
export {
  parseAcceptanceText,
  parseRequirementScopeText,
  projectRequirementsAsOf,
  isRevisionValidAt,
} from "./requirements/asof.js";
export type {
  RequirementAsOfInput,
  RequirementAsOfProjection,
  RequirementAsOfScope,
} from "./requirements/asof.js";
export { decideRequirementOrigin } from "./requirements/origin.js";
export { detectConstraintConflict } from "./requirements/conflict.js";
export type {
  ConstraintConflictDecision,
  ConstraintConflictInput,
} from "./requirements/conflict.js";
export type {
  OriginProofVerdict,
  RequirementOriginDecision,
  RequirementOriginInput,
  RequirementOriginRejectionCode,
} from "./requirements/origin.js";

export { validateStateFactDraft } from "./facts/record.js";
export type { StateFactPlan } from "./facts/record.js";
export {
  buildFactVerificationRow,
  buildVerificationPayload,
  computeIndependent,
  decideVerificationIdempotency,
  factVerificationEventKey,
  isCurrentVerificationRow,
  legacyVerificationView,
  MAX_RESERVATION_IDS,
  MAX_SOURCE_ID_BYTES,
  MAX_SOURCE_IDS,
  validateReservationIds,
  validateSourceIds,
  validateVerifyFactRequest,
} from "./facts/verify.js";
export type {
  ExistingVerification,
  VerificationIdempotencyDecision,
  VerificationPayloadContext,
  VerifyFactContext,
} from "./facts/verify.js";
export {
  buildStateFactView,
  factVisibleAt,
  isIndependent,
  latestValidVerifierRef,
  recomputeTruthState,
  recomputeTruthStateFromResults,
  sortFactsById,
  sortVerifiers,
  verifierVisibleAt,
} from "./facts/aggregate.js";

export { buildFeedbackRecord, FEEDBACK_KINDS, FEEDBACK_STATUSES } from "./feedback/record.js";
export type { FeedbackBuildContext, FeedbackPlan } from "./feedback/record.js";

export { CORRECTION_KINDS, finalizeLedgerCorrection } from "./corrections/apply.js";
export type { CorrectionApplyInput, CorrectionPlan } from "./corrections/apply.js";

export {
  isDuplicateSuccessEvidence,
  SUCCESS_EVIDENCE_KINDS,
  validateSuccessEvidence,
} from "./evidence/record.js";
export type {
  SuccessEvidenceContext,
  SuccessEvidencePlan,
  VerifierEvidenceFacts,
} from "./evidence/record.js";

export { evaluateTaskOutcome } from "./outcome/evaluate.js";
export type { TaskOutcomeEvaluation } from "./outcome/evaluate.js";

export {
  parseAcceptanceFromJson,
  parseBindingFromJson,
  parseJsonArrayStrings,
  parseJsonObject,
  parseJsonValueText,
  parseMethodRefFromJson,
  parseScopeFromJson,
  parseSourceRefArray,
  requireParsed,
} from "./repositories/parse.js";

export {
  checkDecisionActionReason,
  DECISION_ACTION_KINDS,
  DECISION_ACTION_REASON_ALLOWLIST,
  isAllowedDecisionReason,
} from "./decision-policy.js";
export type {
  DecisionActionKind,
  DecisionActionReasonCheck,
  DecisionActionReasonVerdict,
  DecisionReasonCode,
} from "./decision-policy.js";

export { IdentityService } from "./services/identity-service.js";
export type {
  ForkIds,
  ForkOptions,
  ResolveIdentityRequest,
  ResumeRequest,
} from "./services/identity-service.js";
export { RequirementService } from "./services/requirement-service.js";
export { FactService } from "./services/fact-service.js";
export { FeedbackService } from "./services/feedback-service.js";
export { CorrectionService } from "./services/correction-service.js";
export { SuccessEvidenceService, activeRequirementIdsAt } from "./services/evidence-service.js";
export { OutcomeService } from "./services/outcome-service.js";
export type { EvaluateTaskOutcomeRequest } from "./services/outcome-service.js";
export { LedgerReadService } from "./services/ledger-read-service.js";
export { successEvidenceFromRow } from "./services/ledger-read-service.js";
export { commitStateRows, mapCommitOutcome, stateRowWrite } from "./services/commit.js";
export type { CommitResult } from "./services/commit.js";
