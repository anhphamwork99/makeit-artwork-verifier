/**
 * Public contract surface (Testing Seam TS-1).
 *
 * Everything the verification foundation exposes to tests, catalogues, and
 * later Work Packages is re-exported here by name. Internal helpers stay
 * unreachable, so the published module API is the tested contract.
 */

// ── Versioned contract schemas ────────────────────────────────────────────────
export {
  ADAPTER_CATALOGUE_SCHEMA_VERSION,
  ADAPTER_CONTRACT_SCHEMA_VERSION,
  APPLICATION_INVENTORY_SCHEMA_VERSION,
  APPROVED_OPERATION_CATALOGUE_SCHEMA_VERSION,
  BINDING_FIXTURE_CATALOGUE_SCHEMA_VERSION,
  CASE_REQUEST_SCHEMA_VERSION,
  COVERAGE_ATTRIBUTION_SCHEMA_VERSION,
  COVERAGE_MODEL_SCHEMA_VERSION,
  COVERAGE_SELECTION_SCHEMA_VERSION,
  DIAGNOSTIC_RUN_RECORD_SCHEMA_VERSION,
  DIAGNOSTIC_SUITE_RESULT_SCHEMA_VERSION,
  DIAGNOSTIC_SUITE_SCHEMA_VERSION,
  EVIDENCE_REQUIREMENTS_SCHEMA_VERSION,
  EXECUTION_ALLOCATION_SCHEMA_VERSION,
  EXECUTION_INSTANCE_SCHEMA_VERSION,
  EXECUTION_PLAN_SCHEMA_VERSION,
  IDENTITY_SCHEMA_VERSION,
  MATERIALIZED_CASE_SCHEMA_VERSION,
  ORACLE_PROFILE_SCHEMA_VERSION,
  OWNERSHIP_CLEANUP_SCHEMA_VERSION,
  PREFLIGHT_REPORT_SCHEMA_VERSION,
  READINESS_PROFILE_SCHEMA_VERSION,
  SUBJECT_CATALOGUE_SCHEMA_VERSION,
  WORKFLOW_CATALOGUE_SCHEMA_VERSION,
  WORKFLOW_CATALOGUE_V4_SCHEMA_VERSION,
  WORKFLOW_STEP_SCHEMA_VERSION,
} from './contracts/schema-versions';

// ── Closed discriminant vocabulary ────────────────────────────────────────────
export {
  ALLOCATION_FAILURE_REASONS,
  ALLOCATION_STATUSES,
  CAPABILITIES,
  CASE_PROVENANCES,
  CLEANUP_ORDER,
  CLI_STATUSES,
  COMPLETENESS_DIMENSIONS,
  COMPLETENESS_STATUSES,
  COVERAGE_STATUSES,
  DEFERRED_CLI_COMMANDS,
  ENGINE_OPERATIONS,
  EVIDENCE_DEPTHS,
  EVIDENCE_ROLES,
  EXECUTION_PROFILES,
  isCapability,
  isCaseProvenance,
  isDeferredCliCommand,
  isEvidenceDepth,
  isEvidenceRole,
  isExecutionProfile,
  isOutcome,
  isOwnershipKind,
  isSubjectFamily,
  isSubjectId,
  isSubjectOrigin,
  NON_PASS_MEANINGS,
  OWNERSHIP_KINDS,
  OWNERSHIP_PROOF_KINDS,
  PLAN_PHASES,
  PLAN_STATUSES,
  PRESERVED_OWNERSHIP_KINDS,
  REGISTRY_STATUSES,
  SUBJECT_FAMILIES,
  SUBJECT_ID_PATTERN,
  SUBJECT_ORIGINS,
} from './contracts/discriminants';
export type {
  AllocationFailureReason,
  AllocationStatus,
  Capability,
  CaseProvenance,
  CliStatus,
  CompletenessDimension,
  CompletenessStatus,
  CoverageStatus,
  DeferredCliCommand,
  EvidenceDepth,
  EvidenceRole,
  ExecutionProfile,
  FindingSeverity,
  NonPassMeaning,
  OwnershipKind,
  OwnershipProofKind,
  PlanPhaseName,
  PlanStatus,
  RegistryStatus,
  SubjectFamily,
  SubjectOrigin,
} from './contracts/discriminants';

// ── Diagnostics ──────────────────────────────────────────────────────────────
export {
  DIAGNOSTIC_SEVERITY,
  blockingCodes,
  createDiagnostic,
  diagnosticSeverity,
  diagnosticsOfCode,
  formatDiagnostic,
  hasBlockingDiagnostic,
  warningCodes,
} from './contracts/diagnostics';
export type { DiagnosticCode, DiagnosticHints, DiagnosticRecord } from './contracts/diagnostics';

// ── Guarded selection-clearing contract (ADR 0020; WP5 Slice 5-F) ─────────────
export {
  ESCAPE_OWNED_OVERLAY_ROLES,
  SELECTION_CLEAR_CREDIT,
  SELECTION_CLEAR_KEY,
  SELECTION_CLEAR_MAX_DISPATCHES,
  SELECTION_CLEAR_PRIMITIVE,
  SETUP_DIAGNOSTIC_CLASSIFICATION,
  SETUP_DIAGNOSTIC_CODE,
  SETUP_HISTORY_EXPECTED,
  assertHistoryActionEpoch,
  assertSetupHistoryH0H2,
  assertUniqueRailMore,
  attributeMoreControls,
  evaluateEscapeOwnership,
  historyTupleMatches,
  isHistoryActionEpoch,
  rejectAdditionalEscape,
  setupDiagnostic,
  validateEscapeDispatch,
} from './contracts/selection-clear';
export type {
  ActionEpoch,
  EscapeDispatchEvidence,
  EscapeOwnershipFacts,
  EscapeOwnershipVerdict,
  HistoryActionEpoch,
  MoreAttribution,
  MoreAttributionKind,
  MoreControlCandidate,
  RailMoreIdentity,
  SelectionClearCredit,
  SelectionClearEpoch,
  SetupDiagnosticCode,
  SetupHistoryTuple,
} from './contracts/selection-clear';

// ── Cross-subject history contract (ADR 0019; WP5 Slice 5-F) ────────────────
export {
  HISTORY_ACTION_STEPS,
  HISTORY_CONTROLS,
  HISTORY_CONTROL_BUTTON_TYPE,
  HISTORY_CONTROL_NATIVE_TAG,
  HISTORY_NORMALIZATION_PROFILE_ID,
  HISTORY_OBSERVATION_SCHEMA_VERSION,
  HISTORY_ORACLE_PROFILE_ID,
  HISTORY_REQUIRED_CHECKS,
  HISTORY_SETUP_CHECKPOINTS,
  HISTORY_SETUP_H3,
  HISTORY_TRANSITION_PROFILE_ID,
  HISTORY_TRANSITION_TARGET_AWARE,
  INTERACTIVE_HISTORY_V1_DEADLINE_MS,
  INTERACTIVE_HISTORY_V1_TIMING_CATEGORY,
  historyControlName,
  historySetupMeaning,
  historyTupleEquals,
  historyTupleWithCleanEquals,
  historyWorkflowStepsAgree,
  productBaselineClean,
} from './contracts/history-observation';
export type {
  HistoryActionStep,
  HistoryCheckpointMeaning,
  HistoryControlKind,
  HistoryExpectedTuple,
  HistoryRequiredCheckId,
  HistoryTuple,
  HistoryTupleWithClean,
} from './contracts/history-observation';

// ── Catalogue, case, output, and execution contracts ──────────────────────────
export type {
  AdapterCatalogue,
  AdapterCatalogueEntry,
  AdapterDeclaration,
  ApplicationInventory,
  ApprovedOperation,
  ApprovedOperationCatalogue,
  CapabilityBinding,
  FamilyDefault,
  RegistryReconciliation,
  ResolvedSubject,
  SubjectCatalogue,
  SubjectDeclaration,
  WorkflowCatalogue,
  WorkflowCatalogueEntry,
} from './contracts/catalogues';
export type {
  BlockedPlan,
  CaseIntent,
  CaseIntentOperation,
  CaseRequest,
  ContractVersions,
  CorrectnessProjection,
  EnvironmentBlockedPlan,
  ExecutionPlan,
  MaterializedCase,
  MaterializedSubject,
  PlanPhase,
  PlanResult,
  PlannedPlan,
  ReservedPlanResult,
  ResolvedRoute,
  SemanticResourceRef,
} from './contracts/case-model';
export type {
  CoverageAttributionInput,
  CoverageAttributionRecord,
  CoverageCompletenessEntry,
  EvidenceRequirement,
  EvidenceRequirementsManifest,
  NonWeakeningAuditEntry,
  OwnershipCleanupManifest,
  OwnershipProof,
  OwnershipRecord,
  PlannerOutputs,
  PreflightFingerprints,
  PreflightReport,
  PreflightScope,
  PreflightStageId,
  PreflightStageOutcome,
  PreflightStageResult,
} from './contracts/planner-outputs';
export {
  PREFLIGHT_STAGE_IDS,
  PREFLIGHT_STAGE_NAMES,
  PREFLIGHT_STAGE_OUTCOMES,
} from './contracts/planner-outputs';
export type {
  AllocationResult,
  DiagnosticEvidence,
  EphemeralResources,
  ExecutionAllocation,
  ExecutionInstanceResult,
  FailedAllocation,
  OutcomeInput,
  PlanIdentity,
  ReservedAllocation,
} from './contracts/execution';

// ── Canonical serialization and identities ───────────────────────────────────
export {
  CANONICAL_NAMESPACE,
  CanonicalizationError,
  IDENTITY_DOMAINS,
  buildIdentityPreimage,
  canonicalize,
  domainSeparatedDigest,
  identityDigest,
  sha256Hex,
} from './canonical/canonicalize';
export type { IdentityDomain } from './canonical/canonicalize';
export {
  deriveCaseId,
  deriveMaterializationFingerprint,
  derivePlanFingerprint,
  semanticProjection,
} from './canonical/identity';

// ── Catalogue loading, resolution, and fingerprints ──────────────────────────
export {
  CATALOGUE_FILES,
  CatalogueLoadError,
  loadCatalogueBundle,
  parseAdapterCatalogue,
  parseApplicationInventory,
  parseOperationCatalogue,
  parseSubjectCatalogue,
  parseWorkflowCatalogue,
} from './catalogue/load';
export type {
  CatalogueBundle,
  CatalogueLoadErrorCode,
  LoadCatalogueOptions,
} from './catalogue/load';
export { resolveSubjectDeclaration } from './catalogue/resolve';
export type { SubjectResolution } from './catalogue/resolve';
export {
  deriveAdapterCatalogueFingerprint,
  deriveApplicationInventoryFingerprint,
  deriveAbsentCoverageModelFingerprint,
  deriveCoverageModelFingerprint,
  deriveOperationCatalogueFingerprint,
  deriveRegistryFingerprint,
  deriveUndeclaredAdapterCatalogueFingerprint,
  deriveUndeclaredOperationCatalogueFingerprint,
  deriveUndeclaredWorkflowCatalogueFingerprint,
  deriveWorkflowCatalogueFingerprint,
} from './catalogue/fingerprint';

// ── Package 7 Slice A correctness catalogues, compiler, and fingerprints ─────
export {
  CAPTURE_SOURCE_ROLES,
  CHECK_EVALUATORS,
  CHECK_RESULT_STATUSES,
  CURRENTNESS_IDENTITIES,
  DEADLINE_CATEGORIES,
  FULL_CANONICAL_FINGERPRINT_PATTERN,
  NORMALIZATION_APPLICABILITIES,
  NORMALIZATION_COMBINATION,
  NORMALIZATION_EVALUATORS,
  NORMALIZATION_MEANING_REFS,
  ORACLE_EVALUATOR_KINDS,
  TOLERANCE_ALGORITHMS,
  VISUAL_ALGORITHMS,
  VISUAL_AUTHORITY_ROLES,
  VISUAL_BOUNDED_REGIONS,
  VISUAL_COMBINATIONS,
  VISUAL_EVIDENCE_SOURCES,
  VISUAL_MODES,
  isCaptureSourceRole,
  isCheckEvaluator,
  isCheckResultStatus,
  isCurrentnessIdentity,
  isDeadlineCategory,
  isFullCanonicalFingerprint,
  isOracleEvaluatorKind,
  isToleranceAlgorithm,
  isVisualAlgorithm,
  isVisualBoundedRegion,
  isVisualEvidenceSource,
  isVisualMode,
} from './contracts/correctness';
export type {
  BindingCorrectnessLedgerEntry,
  BindingCorrectnessState,
  CapabilityBaselineDeclaration,
  CaptureDeclaration,
  CaptureSourceDeclaration,
  CheckEvaluator,
  CheckResultStatus,
  CorrectnessCatalogue,
  CorrectnessCheckResult,
  CorrectnessComponentFingerprints,
  ActionCycleCorrectnessIdentity,
  ConsumedCorrectnessComponentFingerprints,
  CorrectnessReferenceEntry,
  DeadlineCategory,
  NonWeakeningAssertion,
  NormalizationApplicability,
  NormalizationDeclaration,
  NormalizationEvaluator,
  NormalizationMeaningRef,
  OracleCheckDeclaration,
  OracleDeclaration,
  OracleEvaluatorKind,
  ReadinessDeclaration,
  ResolvedCheckContract,
  ResolvedCorrectnessProfile,
  ResolvedNormalization,
  RouteProfileSelectionDeclaration,
  SubjectAdditionDeclaration,
  ToleranceAlgorithm,
  ToleranceDeclaration,
  VisualAlgorithm,
  VisualAuthorityDeclaration,
  VisualAuthorityRole,
  VisualBoundedRegion,
  VisualCombination,
  VisualEvidenceSource,
  VisualMode,
} from './contracts/correctness';

// ── P7-B B1-A inactive final result contract and pure kernels (ADR 0028 §3) ───
export {
  RESULT_CONTRACT_ISSUE_CODES,
  isPlainRecord,
  projectCorrectnessProfileIdentity,
  resultIssue,
  validateCheckResultShape,
  validateResultIdentityAgreement,
} from './contracts/result-agreement';
export type {
  CorrectnessProfileIdentityView,
  ResultContractIssue,
  ResultContractIssueCode,
  ResultContractValidation,
} from './contracts/result-agreement';
export {
  CURRENT_RESULT_LABEL,
  FINAL_CURRENT_RESULT_SCHEMA_VERSION,
  LEGACY_RESULT_LABELS,
  LEGACY_RESULT_SCHEMA_VERSIONS,
  RUN_RECORD_VERSION_KINDS,
  classifyLegacyCheckResult,
  discriminateRunRecordVersion,
  validateCurrentResultRecordV4,
} from './contracts/final-result-dto';
export type {
  FinalCurrentResultRecord,
  FinalResultRecordValidation,
  LegacyCheckResultClassification,
  RunRecordVersionDiscrimination,
  RunRecordVersionKind,
} from './contracts/final-result-dto';
export {
  COMMAND_CHECK_CONTEXTS,
  isCommandCheckContext,
  validateCheckContextSeparation,
  validateCommandCheck,
} from './contracts/command-check';
export type {
  CommandCheckContext,
  CommandCheckResult,
  CommandStatusAuthority,
} from './contracts/command-check';
export {
  FINAL_CURRENT_CHILD_RECORD_SCHEMA_VERSION,
  FINAL_NESTED_PROJECTION_FAMILIES,
  FINAL_NESTED_PROJECTION_SCHEMA_VERSION,
  FINAL_RECORD_ASSEMBLY_ISSUE_CODES,
  assembleFinalChildRecordV4,
  assembleFinalCommandRecordV4,
  isFinalCommandRecordShape,
  validateFinalChildRecordV4,
  validateFinalCommandRecordV4,
} from './contracts/final-record-v4';
export type {
  AssembleFinalChildRecordV4Input,
  CommandCheckResultView,
  FinalActionCycleProjectionV4,
  FinalChildRecordAssemblyResult,
  FinalCommandCheckRecordV4,
  FinalCommandRecordAssemblyResult,
  FinalCrosswordExecutionProjectionV4,
  FinalCrosswordProjectionV4,
  FinalCurrentChildRecordV4,
  FinalHistoryProjectionV4,
  FinalImageCycleProjectionV4,
  FinalImageProjectionV4,
  FinalNestedProjectionFamily,
  FinalNestedProjectionV4,
  FinalRecordAssemblyFailure,
  FinalRecordAssemblyIssueCode,
  FinalRecordIssue,
  FinalRecordIssueCode,
  FinalRecordValidation,
  FinalRestoreProjectionV4,
} from './contracts/final-record-v4';
export {
  FINAL_COMMAND_RECORD_READER_LABEL,
  FINAL_CURRENT_RECORD_READER_LABEL,
  FINAL_INVALID_RECORD_READER_LABEL,
  FINAL_MIXED_RECORD_READER_LABEL,
  FINAL_UNKNOWN_RECORD_READER_LABEL,
  isCurrentCommandRecord,
  isCurrentFinalRecord,
  isLegacyFinalRecord,
  readCurrentFinalRecordOrThrow,
  readFinalRecord,
} from './contracts/final-record-reader';
export type {
  FinalCommandRecordView,
  FinalCurrentRecordView,
  FinalLegacyRecordView,
  FinalRecordReadResult,
  FinalRejectedRecordView,
} from './contracts/final-record-reader';
// ── ADR 0032 §E3-S2: current strict-v4 public evidence port ──────────────────
export {
  FINAL_PUBLIC_COMMAND_RECORD_LABEL,
  FINAL_PUBLIC_CURRENT_RECORD_LABEL,
  FINAL_PUBLIC_FINDING_SEVERITIES,
  FINAL_PUBLIC_PATH_REF_DOMAIN,
  FINAL_PUBLIC_PATH_ROLES,
  FINAL_PUBLIC_RECORD_SCHEMA_VERSION,
  FINAL_PUBLIC_RUN_RECORD_COMMAND,
  assembleFinalPublicCommandRecordV4,
  assembleFinalPublicRunRecordV4,
  isCurrentFinalPublicCommandRecord,
  isCurrentFinalPublicRunRecord,
  isFinalPublicCommandRecordShape,
  isLegacyFinalPublicRecord,
  readCurrentFinalPublicRunRecordOrThrow,
  readFinalPublicRecord,
  validateFinalPublicCommandRecordV4,
  validateFinalPublicRecordV4,
  validateFinalPublicRunRecordV4,
} from './contracts/final-public-record';
export type {
  AssembleFinalPublicCommandRecordV4Input,
  AssembleFinalPublicRunRecordV4Input,
  FinalPublicCommandRecordAssemblyResult,
  FinalPublicCommandRecordV4,
  FinalPublicCurrentCommandRecordView,
  FinalPublicCurrentRunRecordView,
  FinalPublicRecordAssemblyFailure,
  FinalPublicRecordReadResult,
  FinalPublicRecordV4,
  FinalPublicRecordValidation,
  FinalPublicRunRecordAssemblyResult,
  FinalPublicRunRecordV4,
} from './contracts/final-public-record';
export {
  FINAL_SUITE_AGGREGATE_STATUSES,
  FINAL_SUITE_CHILD_CURRENT_LABEL,
  FINAL_SUITE_CHILD_CURRENT_LABEL_VALUE,
  FINAL_SUITE_CHILD_REFUSAL_LABEL,
  FINAL_SUITE_RECORD_COMMAND,
  FINAL_SUITE_RECORD_EXECUTION,
  FINAL_SUITE_RECORD_ISSUE_CODES,
  FINAL_SUITE_RECORD_LABEL,
  FINAL_SUITE_RECORD_PROFILE,
  FINAL_SUITE_RECORD_SCHEMA_VERSION,
  assembleFinalSuiteRecordV2,
  buildFinalSuiteRecordV2,
  readFinalSuiteRecord,
  validateFinalSuiteRecordV2,
} from './contracts/final-suite-record';
export type {
  FinalSuiteAggregateStatus,
  FinalSuiteChildRecordV2,
  FinalSuiteCurrentV2View,
  FinalSuiteInvalidView,
  FinalSuiteLegacyV1View,
  FinalSuiteRecordAssemblyFailure,
  FinalSuiteRecordAssemblyResult,
  FinalSuiteRecordIssue,
  FinalSuiteRecordIssueCode,
  FinalSuiteRecordReadResult,
  FinalSuiteRecordV2,
  FinalSuiteRecordValidation,
} from './contracts/final-suite-record';
export {
  prepareFinalPublicCommandRecordV4,
  prepareFinalPublicRunRecordV4,
  readBackFinalPublicCommandRecordV4,
  readBackFinalPublicRunRecordV4,
  serializePreparedFinalPublicCommandRecordV4,
  serializePreparedFinalPublicRunRecordV4,
  validatePreparedFinalPublicCommandRecordV4,
  validatePreparedFinalPublicRunRecordV4,
  writeFinalPublicCommandRecordV4,
  writeFinalPublicRunRecordV4,
} from './evidence/final-writer';
export type {
  PreparedFinalPublicCommandRecordV4,
  PreparedFinalPublicRunRecordV4,
  WriteFinalPublicCommandRecordV4Input,
  WriteFinalPublicCommandRecordV4Result,
  WriteFinalPublicRunRecordV4Input,
  WriteFinalPublicRunRecordV4Result,
} from './evidence/final-writer';
export { readFinalPublicRecordFile } from './evidence/final-reader';
export {
  FINAL_SUITE_RECORD_FILE_NAME,
  readBackFinalSuiteRecordV2,
  writeFinalSuiteRecordV2,
} from './evidence/final-suite-writer';
export type {
  WriteFinalSuiteRecordV2Input,
  WriteFinalSuiteRecordV2Result,
} from './evidence/final-suite-writer';
export { readFinalSuiteRecordFile } from './evidence/final-suite-reader';
export {
  STATUS_OUTCOME_PRECEDENCE,
  classifyBehaviorOutcome,
  classifyFinalOutcome,
  classifyStatusOutcome,
  statusNonPassIsBlocking,
  statusNonPassMeaning,
} from './runtime/result-outcome';
export type {
  ClassifiedStatusOutcome,
  FinalStatusOutcomeInput,
  StatusCheckView,
  StatusOutcomeInput,
} from './runtime/result-outcome';

// ── P7-B B1-B inactive compiled-profile Text kernels (ADR 0028 §3 B1-B) ───────
export {
  TEXT_AUTHORITY_STATES,
  TEXT_EVIDENCE_AVAILABILITY,
  TEXT_FACT_CURRENTNESS,
  TEXT_KERNEL_ISSUE_CODES,
  TEXT_KERNEL_KINDS,
  evaluateOrdinaryTextChecks,
  evaluateWarpedTextChecks,
  isTextEvidenceAvailability,
  isTextFactCurrentness,
  textCurrentnessForAuthority,
  textKernelKindForEvaluator,
} from './kernels/text-kernel';
export type {
  OrdinaryTextDeltaFact,
  OrdinaryTextKernelFacts,
  TextAuthorityState,
  TextEvaluatorFact,
  TextEvidenceAvailability,
  TextEvidenceFact,
  TextFactCurrentness,
  TextKernelInput,
  TextKernelIssue,
  TextKernelIssueCode,
  TextKernelKind,
  TextKernelResult,
  TextKernelRoute,
  TextKernelVector,
  WarpedTextCheckFact,
  WarpedTextDeltaEvidenceFact,
  WarpedTextEnvelopeEvidenceFact,
  WarpedTextKernelFacts,
} from './kernels/text-kernel';

// ── P7-B B1-C inactive compiled-profile nested-Object kernel (ADR 0028 §3 B1-C)
export {
  NESTED_OBJECT_AUTHORITY_STATES,
  NESTED_OBJECT_EVIDENCE_AVAILABILITY,
  NESTED_OBJECT_FACT_CURRENTNESS,
  NESTED_OBJECT_KERNEL_EVALUATOR,
  NESTED_OBJECT_KERNEL_ISSUE_CODES,
  NESTED_OBJECT_KERNEL_KINDS,
  evaluateNestedObjectChecks,
  isNestedObjectEvidenceAvailability,
  isNestedObjectFactCurrentness,
  nestedObjectCurrentnessForAuthority,
  nestedObjectKernelKindForEvaluator,
} from './kernels/nested-object-kernel';
export type {
  NestedObjectAuthorityState,
  NestedObjectCompositionFact,
  NestedObjectEvaluatorFact,
  NestedObjectEvidenceAvailability,
  NestedObjectEvidenceFact,
  NestedObjectFactCurrentness,
  NestedObjectFixtureNormalizationFact,
  NestedObjectGeometryProjectionFact,
  NestedObjectInteractionAuthorityFact,
  NestedObjectInteractionPairFact,
  NestedObjectKernelFacts,
  NestedObjectKernelInput,
  NestedObjectKernelIssue,
  NestedObjectKernelIssueCode,
  NestedObjectKernelKind,
  NestedObjectKernelResult,
  NestedObjectKernelRoute,
  NestedObjectKernelVector,
  NestedObjectMovementFact,
  NestedObjectOracleFactsView,
  NestedObjectPaddingFact,
  NestedObjectPersistedFrameFact,
  NestedObjectPointDeltaFact,
  NestedObjectRenderFrameFact,
  NestedObjectRepresentationFact,
  NestedObjectSegmentFact,
  NestedObjectWrappersFact,
} from './kernels/nested-object-kernel';

// ── P7-B B1-D inactive compiled-profile Image kernel (ADR 0028 §3 B1-D) ───────
export {
  IMAGE_AUTHORITY_STATES,
  IMAGE_EVIDENCE_AVAILABILITY,
  IMAGE_FACT_CURRENTNESS,
  IMAGE_KERNEL_CHECK_EVALUATORS,
  IMAGE_KERNEL_EVALUATOR,
  IMAGE_KERNEL_ISSUE_CODES,
  IMAGE_KERNEL_KINDS,
  IMAGE_READINESS_OUTCOMES,
  evaluateImageChecks,
  imageCurrentnessForAuthority,
  imageKernelKindForEvaluator,
  isImageEvidenceAvailability,
  isImageReadinessOutcome,
} from './kernels/image-kernel';
export type {
  ImageAuthorityState,
  ImageEvaluatorFact,
  ImageEvidenceAvailability,
  ImageEvidenceFact,
  ImageFactCurrentness,
  ImageKernelAcceptedUploadFact,
  ImageKernelFacts,
  ImageKernelInput,
  ImageKernelIssue,
  ImageKernelIssueCode,
  ImageKernelKind,
  ImageKernelResourceFact,
  ImageKernelResourceProbeFact,
  ImageKernelResult,
  ImageKernelRoute,
  ImageKernelVector,
  ImageOracleFactsView,
  ImagePrimitiveCheckFactView,
  ImageReadinessFact,
  ImageReadinessObservationFact,
  ImageReadinessOutcome,
  ImageReadinessPolicyFact,
} from './kernels/image-kernel';

// ── P7-B B1-E inactive compiled-profile Crossword kernel (ADR 0028 §3 B1-E) ───
export {
  CROSSWORD_AUTHORITY_STATES,
  CROSSWORD_EVIDENCE_AVAILABILITY,
  CROSSWORD_FACT_CURRENTNESS,
  CROSSWORD_KERNEL_CHECK_EVALUATORS,
  CROSSWORD_KERNEL_EVALUATOR,
  CROSSWORD_KERNEL_ISSUE_CODES,
  CROSSWORD_KERNEL_KINDS,
  crosswordCurrentnessForAuthority,
  crosswordKernelKindForEvaluator,
  evaluateCrosswordChecks,
  isCrosswordEvidenceAvailability,
} from './kernels/crossword-kernel';
export type {
  CrosswordAuthorityState,
  CrosswordEvaluatorFact,
  CrosswordEvidenceAvailability,
  CrosswordEvidenceFact,
  CrosswordFactCurrentness,
  CrosswordKernelChildProjection,
  CrosswordKernelFacts,
  CrosswordKernelInput,
  CrosswordKernelIssue,
  CrosswordKernelIssueCode,
  CrosswordKernelKind,
  CrosswordKernelResult,
  CrosswordKernelRoute,
  CrosswordOracleFactsView,
  CrosswordPrimitiveCheckFactView,
} from './kernels/crossword-kernel';

// ── P7-B B1-F1 inactive compiled-profile cross-subject History kernel (ADR 0028 §3 B1-F)
export {
  HISTORY_AUTHORITY_SCOPES,
  HISTORY_AUTHORITY_STATES,
  HISTORY_EVIDENCE_AVAILABILITY,
  HISTORY_FACT_CURRENTNESS,
  HISTORY_KERNEL_CHECK_EVALUATORS,
  HISTORY_KERNEL_EVALUATOR,
  HISTORY_KERNEL_ISSUE_CODES,
  HISTORY_KERNEL_KINDS,
  HISTORY_READINESS_OUTCOMES,
  evaluateHistoryChecks,
  historyCurrentnessForAuthority,
  historyKernelKindForEvaluator,
  isHistoryEvidenceAvailability,
  isHistoryReadinessOutcome,
  readHistoryKernelTuple,
} from './kernels/history-kernel';
export type {
  HistoryAuthorityScope,
  HistoryAuthorityState,
  HistoryEvaluatorFact,
  HistoryEvidenceAvailability,
  HistoryEvidenceFact,
  HistoryFactCurrentness,
  HistoryKernelFacts,
  HistoryKernelInput,
  HistoryKernelIssue,
  HistoryKernelIssueCode,
  HistoryKernelKind,
  HistoryKernelResult,
  HistoryKernelRoute,
  HistoryKernelSetupProjection,
  HistoryKernelTransitionProjection,
  HistoryKernelTupleView,
  HistoryOracleFactsView,
  HistoryPrimitiveCheckFactView,
  HistoryPrimitiveSetupFactView,
  HistoryPrimitiveTransitionFactView,
  HistoryReadinessFact,
  HistoryReadinessObservationFact,
  HistoryReadinessOutcome,
  HistoryReadinessPolicyFact,
} from './kernels/history-kernel';

// ── P7-B B1-F2 inactive compiled-profile frontend serialize/restore kernel (ADR 0028 §3 B1-F)
// B1-F is complete only when F1 and F2 are jointly green.
export {
  RESTORE_AUTHORITY_SCOPES,
  RESTORE_AUTHORITY_STATES,
  RESTORE_EVIDENCE_AVAILABILITY,
  RESTORE_FACT_CURRENTNESS,
  RESTORE_KERNEL_CHECK_EVALUATORS,
  RESTORE_KERNEL_EVALUATOR,
  RESTORE_KERNEL_ISSUE_CODES,
  RESTORE_KERNEL_KINDS,
  RESTORE_READINESS_OUTCOMES,
  evaluateRestoreChecks,
  isRestoreEvidenceAvailability,
  isRestoreReadinessOutcome,
  restoreCurrentnessForAuthority,
  restoreKernelKindForEvaluator,
} from './kernels/restore-kernel';
export type {
  RestoreAuthorityScope,
  RestoreAuthorityState,
  RestoreDocumentObservationFact,
  RestoreEvaluatorFact,
  RestoreEvidenceAvailability,
  RestoreEvidenceFact,
  RestoreFactCurrentness,
  RestoreKernelDocumentProjection,
  RestoreKernelFacts,
  RestoreKernelInput,
  RestoreKernelIssue,
  RestoreKernelIssueCode,
  RestoreKernelKind,
  RestoreKernelResult,
  RestoreKernelRoute,
  RestoreKernelSetupProjection,
  RestoreOracleFactsView,
  RestorePrimitiveCheckFactView,
  RestoreReadinessFact,
  RestoreReadinessObservationFact,
  RestoreReadinessOutcome,
  RestoreReadinessPolicyFact,
  RestoreSetupCheckpointFact,
  RestoreViewportFact,
} from './kernels/restore-kernel';

// ── P7-B B1-G inactive explicit-status command contexts (ADR 0028 §3 B1-G) ────
// Doctor and production-absence consume their own versioned command authority
// and never fabricate a compiled correctness profile.
export {
  COMMAND_AUTHORITY_STATES,
  COMMAND_CONTEXT_ISSUE_CODES,
  COMMAND_EVIDENCE_AVAILABILITIES,
  COMMAND_NEGATIVE_DISPOSITIONS,
  deriveCommandAuthorityFingerprint,
  evaluateCommandContext,
  isCommandAuthorityState,
  isCommandEvidenceAvailability,
  isCommandNegativeDisposition,
  projectCommandStatusAuthority,
  sameCommandContext,
  validateCommandAuthorityAgreement,
  validateCommandAuthorityDeclaration,
  validateCommandContextResult,
} from './commands/command-context';
export type {
  CommandAuthorityDeclaration,
  CommandAuthorityState,
  CommandCheckDeclaration,
  CommandCheckFact,
  CommandContextInput,
  CommandContextIssue,
  CommandContextIssueCode,
  CommandContextOutcome,
  CommandContextResult,
  CommandEvidenceAvailability,
  CommandEvidenceFact,
  CommandNegativeDisposition,
} from './commands/command-context';
export {
  DOCTOR_COMMAND_AUTHORITY,
  DOCTOR_COMMAND_AUTHORITY_ID,
  DOCTOR_COMMAND_CHECKS,
  DOCTOR_COMMAND_CONTEXT,
  DOCTOR_COMMAND_DIAGNOSTIC_EVIDENCE,
  DOCTOR_COMMAND_EXPECTED_BRIDGE_VERSION,
  DOCTOR_COMMAND_MIN_LAYOUTS,
  DOCTOR_COMMAND_REQUIRED_EVIDENCE,
  DOCTOR_COMMAND_REQUIRED_STAGE_LAYERS,
  DOCTOR_COMMAND_SCHEMA_VERSION,
  DOCTOR_COMMAND_STATUS_AUTHORITY,
  evaluateDoctorCommandChecks,
} from './commands/doctor-command-context';
export {
  PRODUCTION_ABSENCE_COMMAND_AUTHORITY,
  PRODUCTION_ABSENCE_COMMAND_AUTHORITY_ID,
  PRODUCTION_ABSENCE_COMMAND_CHECKS,
  PRODUCTION_ABSENCE_COMMAND_CONTEXT,
  PRODUCTION_ABSENCE_COMMAND_DIAGNOSTIC_EVIDENCE,
  PRODUCTION_ABSENCE_COMMAND_REQUIRED_EVIDENCE,
  PRODUCTION_ABSENCE_COMMAND_ROUTE,
  PRODUCTION_ABSENCE_COMMAND_SCHEMA_VERSION,
  PRODUCTION_ABSENCE_COMMAND_STATUS_AUTHORITY,
  evaluateProductionAbsenceCommandChecks,
} from './commands/production-absence-command-context';
export {
  CORRECTNESS_CATALOGUE_FILES,
  CorrectnessCatalogueError,
  assembleCorrectnessCatalogue,
  buildBindingCorrectnessLedger,
  compileDeliveredRouteProfiles,
  compileResolvedCorrectnessProfile,
  deriveAbsentCorrectnessProfileFingerprint,
  deriveCapabilityBaselineFingerprint,
  deriveCaptureFingerprint,
  deriveCorrectnessCatalogueFingerprint,
  deriveNormalizationFingerprint,
  deriveOracleFingerprint,
  deriveReadinessFingerprint,
  deriveRequiredCheckSetFingerprint,
  deriveResolvedCorrectnessProfileFingerprint,
  deriveSubjectAdditionFingerprint,
  deriveToleranceFingerprint,
  deriveVisualAuthorityFingerprint,
  isSha256Hex,
  loadCorrectnessCatalogue,
  resolveRouteSelection,
  validateCorrectnessCatalogue,
} from './catalogue/correctness';
export type {
  CorrectnessCatalogueErrorCode,
  LoadCorrectnessOptions,
} from './catalogue/correctness';
export {
  auditCorrectnessCompatibility,
  auditWp5Compatibility,
} from './catalogue/correctness-compatibility';
export {
  WP5_COMPATIBILITY_ORACLE,
  WP5_DIAGNOSTIC_SCREENSHOT_VISUAL,
} from './catalogue/wp5-compatibility-oracle';
export type {
  Wp5CompatibilityNormalization,
  Wp5CompatibilityOracleEntry,
  Wp5CompatibilityProjection,
  Wp5CompatibilityRoute,
} from './catalogue/wp5-compatibility-oracle';

export type { ValidatePackage7Details, ValidatedCorrectnessProfile } from './cli/validate';

// ── Package 7 Slice C completeness ledger (gap-plan §5 P7-C; ADR 0039) ───────
export {
  ACCEPTED_REPRESENTATIVE_SUITE_EXECUTION_ID,
  ACCEPTED_REPRESENTATIVE_SUITE_ID,
  EVIDENCE_RUNS_DIR_NAME,
  EVIDENCE_SUITES_DIR_NAME,
  PACKAGE7_COMPLETENESS_DIMENSIONS,
  PACKAGE7_COMPLETENESS_LEDGER_ARTIFACT_ID,
  PACKAGE7_COMPLETENESS_LEDGER_BRANCH,
  PACKAGE7_COMPLETENESS_LEDGER_FILE_NAME,
  PACKAGE7_COMPLETENESS_LEDGER_LABEL,
  PACKAGE7_COMPLETENESS_LEDGER_RELATIVE_PATH,
  PACKAGE7_COMPLETENESS_LEDGER_SCHEMA_VERSION,
  PACKAGE7_COMPLETENESS_NON_CLAIMS,
  PACKAGE7_COMPLETENESS_STATUSES,
  PACKAGE7_ACCEPTED_SUITE_STATES,
  isPackage7AcceptedSuiteState,
  isPackage7CompletenessDimension,
  isPackage7CompletenessStatus,
} from './contracts/completeness';
export type {
  Package7AcceptedSuiteChildProjection,
  Package7AcceptedSuiteProjection,
  Package7AcceptedSuiteState,
  Package7BindingLedgerEntry,
  Package7CompiledProfileEntry,
  Package7CompletenessBuildResult,
  Package7CompletenessCounts,
  Package7CompletenessDimension,
  Package7CompletenessDimensionName,
  Package7CompletenessLedger,
  Package7CompletenessStatus,
  Package7CoverageModelLedgerEntry,
} from './contracts/completeness';
export {
  buildPackage7CompletenessLedger,
  completenessLedgerArtifactPath,
  persistCompletenessLedgerFile,
  projectAcceptedRepresentativeSuite,
  serializeCompletenessLedger,
} from './catalogue/completeness';
export type {
  BuildCompletenessLedgerInput,
  PersistCompletenessLedgerResult,
  ProjectAcceptedSuiteOptions,
  ProjectAcceptedSuiteResult,
} from './catalogue/completeness';

// ── Registry reconciliation and validation ───────────────────────────────────
export { reconcileRegistry } from './registry/reconcile';
export type { ReconcileRegistryInput } from './registry/reconcile';
export {
  duplicateSubjectIds,
  validateApplicationReconciliation,
  validateExecutableCatalogueReconciliation,
  validateResolvedRelationships,
  validateSubjectDeclarations,
} from './registry/validate';

// ── Routing ──────────────────────────────────────────────────────────────────
export {
  evaluateVariantPolicy,
  resolveAdapterForSubject,
  resolveCapabilityBinding,
  resolveRoute,
} from './routing/resolve';
export type { RouteResolution, RouteResult, VariantPolicyEvaluation } from './routing/resolve';

// ── Planner ──────────────────────────────────────────────────────────────────
export { normalizeCaseIntent, normalizeCaseRequest } from './planner/normalize-intent';
export type { IntentNormalizeResult, NormalizeResult } from './planner/normalize-intent';
export {
  buildContractVersions,
  materializeCase,
  materializeSubject,
  resolveWorkflowVersion,
} from './planner/materialize';
export type { ContractVersionInput, MaterializeCaseInput } from './planner/materialize';
export { compilePlan } from './planner/compile-plan';
export type { CompilePlanInput } from './planner/compile-plan';
export {
  PreflightTracker,
  buildCoverageAttribution,
  buildEvidenceRequirements,
  buildNonWeakeningAudit,
  buildPlannerOutputs,
  buildPreflightReport,
  rejectPreflightReport,
  resolvePreflightStage,
} from './planner/preflight';
export type { PlannerOutputsInput, PreflightReportInput } from './planner/preflight';
export { correctnessProjection, planAndReserve, planCase } from './planner/plan-case';
export type { PlanAndReserveContext, PlannerContext } from './planner/plan-case';

// ── Allocation and ownership ─────────────────────────────────────────────────
export {
  createAllocationLedger,
  reserveAllocation,
  validateEphemeralResources,
} from './allocation/reserve';
export type {
  AllocationLedger,
  ResourceValidation,
  ResourceValidationFailure,
} from './allocation/reserve';
export { buildOwnershipCleanupManifest } from './allocation/ownership';
export type { OwnershipManifestInput } from './allocation/ownership';

// ── Coverage Model, deterministic selection, and accounting ──────────────────
export {
  COVERAGE_COMBINATION_CLASSIFICATIONS,
  COVERAGE_DEFAULT_RESIDUAL_STRENGTH,
  COVERAGE_MAX_RESIDUAL_STRENGTH,
  COVERAGE_MAX_UNIVERSE_ASSIGNMENTS,
  COVERAGE_OBLIGATION_KINDS,
  COVERAGE_PARTITION_VALIDITIES,
  COVERAGE_RESIDUAL_POLICY_KINDS,
  COVERAGE_SCENARIO_ELIGIBILITIES,
  COVERAGE_SELECTION_POLICY_VERSION,
  SELECTED_COVERAGE_CASE_ORIGINS,
  SELECTED_COVERAGE_RELEASE_BASES,
} from './contracts/coverage';
export type {
  BindingCoverageModel,
  CoverageCombinationClassification,
  CoverageConstraint,
  CoverageFactor,
  CoverageFactorValue,
  CoverageModelCatalogue,
  CoverageObligation,
  CoverageObligationKind,
  CoverageObligationMapping,
  CoverageObligationMatch,
  CoveragePartition,
  CoveragePartitionValidity,
  CoverageResidualPolicy,
  CoverageResidualPolicyKind,
  CoverageResidualSubmodel,
  CoverageScalar,
  CoverageScenario,
  CoverageScenarioEligibility,
  CoverageSelection,
  CoverageTupleCoverage,
  CoverageTupleLevel,
  CoverageTupleMember,
  CoverageUnsupportedCombination,
  SelectedCoverageCase,
  SelectedCoverageCaseOrigin,
  SelectedCoverageReleaseBasis,
} from './contracts/coverage';
export { CoverageCatalogueError, parseCoverageModelCatalogue } from './coverage/load';
export {
  assignmentHasSellerInvalidValue,
  assignmentMatches,
  computeUniverseSize,
  CoverageUniverseUnboundedError,
  enumerateUniverse,
  indexFactors,
  isUniverseBounded,
  obligationSatisfiedByAssignment,
  partitionOfValue,
  validateCoverageCatalogue,
  validateCoverageModel,
} from './coverage/validate';
export type {
  CoverageAssignment,
  CoverageFactorIndex,
  CoverageUniverse,
} from './coverage/validate';
export {
  describeProjectScope,
  resolveBindingCoverage,
  resolveCaseCoverage,
  resolveIntentPointer,
} from './coverage/resolve';
export type {
  BindingCoverageResolution,
  CaseCoverageResolution,
  ProjectScopeDescription,
  ResolvedCaseCoverage,
} from './coverage/resolve';
export { selectCoverage } from './coverage/select';
export type { SelectCoverageOptions } from './coverage/select';
export {
  buildModelCompleteness,
  deriveCoverageCompleteness,
  selectedCaseKeys,
  selectionTupleCoverage,
  unqualifiedCompletenessIsBlocking,
  validateCoverageCompleteness,
} from './coverage/account';
export type { CoverageCompletenessInput, ModelCompleteness } from './coverage/account';

// ── Outcomes ─────────────────────────────────────────────────────────────────
export { OUTCOMES } from './contracts/discriminants';
export type { Outcome } from './contracts/discriminants';

// ── Owned runtime, Doctor, cleanup, and CLI contracts (WP3, TS-2/TS-4/TS-5) ────
export {
  BROWSER_KINDS,
  ENVIRONMENT_CELL_CLASSIFICATIONS,
  OBSERVED_ENVIRONMENT_FACTS,
  RUN_OWNERSHIP_STATES,
} from './contracts/runtime';

// ── Gate G executable selection-manifest draft (no approval or Release credit) ──
export { EXECUTABLE_SELECTION_MANIFEST_SCHEMA_VERSION } from './contracts/executable-selection-manifest';
export type {
  ExecutableManifestAccounting,
  ExecutableManifestBindingSelection,
  ExecutableManifestContentV1,
  ExecutableManifestEntry,
  ExecutableManifestExclusion,
  ExecutableManifestExclusionCode,
  ExecutableManifestGenerationResult,
  ExecutableManifestValidationContext,
  ExecutableManifestValidationResult,
  ExecutableScenarioRequestTemplate,
  ExecutableSelectionManifestDraftV1,
  ValidatedEnvironmentCell,
} from './contracts/executable-selection-manifest';
export {
  generateExecutableSelectionManifest,
  validateExecutableSelectionManifest,
} from './governance/executable-selection-manifest';
export type {
  BrowserKind,
  CliResult,
  CleanupResult,
  CleanupVerification,
  DoctorResult,
  EnvironmentCatalogue,
  EnvironmentCell,
  EnvironmentCellClassification,
  EnvironmentFactMismatch,
  EnvironmentFacts,
  LaunchabilityProjection,
  ObservedEnvironmentFact,
  ObservedEnvironmentFacts,
  RunAllocation,
  RunAllocationFailure,
  RunAllocationResult,
  RunOwnershipRecord,
  RunOwnershipState,
} from './contracts/runtime';
export { allocateRun, allocationFailureCliStatus, isPortFree } from './allocation/allocate';
export type { AllocateRunInput, PortReserver } from './allocation/allocate';
export {
  hasRunPortReservation,
  holdRunPortReservation,
  releaseAllRunPortReservations,
  releaseRunPortReservation,
  reserveLoopbackPort,
  runPortReservationPort,
} from './allocation/port-reservation';
export type { PortReservation, PortReservationResult } from './allocation/port-reservation';
export {
  ownershipProcessFieldsProblem,
  readLiveProcessIdentity,
  verifyRecordedProcessIdentity,
} from './allocation/process-identity';
export type { LiveProcessIdentity } from './allocation/process-identity';
export {
  OWNERSHIP_FILE,
  SCRATCH_PREFIX,
  admitCase,
  evidenceRootFor,
  expectedDistDirFor,
  isProcessAlive,
  isProcessGroupAlive,
  ownershipRecordIsVerifiable,
  ownershipRecordPathFor,
  readOwnershipRecord,
  releaseCase,
  runIsLiveOwned,
  scratchRootFor,
  updateOwnershipRecord,
  writeOwnershipRecord,
} from './allocation/lease';
export { cleanupRun } from './cleanup/cleanup';
export type { CleanupRunOptions } from './cleanup/cleanup';
export {
  DEFAULT_ENVIRONMENT_CELL_ID,
  ENVIRONMENT_CATALOGUE_FILE,
  EnvironmentCatalogueError,
  loadEnvironmentCatalogue,
  parseEnvironmentCatalogue,
  resolveEnvironmentCell,
} from './runtime/environment';
export {
  collectAppRevision,
  collectEnvironmentFacts,
  lockfileDigest,
} from './runtime/environment-facts';
export {
  RUN_ID_PATTERN,
  VERIFY_DIST_DIR_ROOT,
  isSafeRunId,
  repoRelativeDistDir,
  resolveRepoRoot,
  resolveSkillRoot,
  resolveToolkitRoot,
} from './runtime/paths';
export {
  EVIDENCE_ROOT_ENV,
  defaultEvidenceBaseDir,
  evidenceBaseDir,
  evidenceRunRoot,
  evidenceRunRootRelativePath,
  evidenceSuiteRoot,
  evidenceSuiteRootRelativePath,
  explicitEvidenceRootProblem,
  resolveEvidenceRoot,
} from './runtime/evidence-root';
export type {
  EvidenceRootOrigin,
  EvidenceRootResolution,
  ResolvedEvidenceRoot,
} from './runtime/evidence-root';
export {
  PRODUCT_MEANING_PROVIDER_ENTRY_RELATIVE_PATH,
  PRODUCT_MEANING_PROVIDER_EXPORT_NAME,
  PRODUCT_MEANING_PROVIDER_PROFILE_ID,
  PRODUCT_MEANING_PROVIDER_SCHEMA_VERSION,
  validateProductMeaningProvider,
} from './contracts/product-meaning-provider';
export type {
  NormalizedArtworkMeaningView,
  ProductMeaningProviderEnvelopeV1,
  ProductMeaningProviderV1,
  RawCrosswordSemanticPayloadView,
} from './contracts/product-meaning-provider';
export {
  HOST_CAPABILITY_REQUIREMENTS,
  HOST_COMPATIBILITY_SCHEMA_VERSION,
  assessHostCompatibility,
  requiredHostCapabilitiesForWorkflows,
} from './contracts/host-compatibility';
export type {
  HostCapabilityId,
  HostCompatibilityAssessment,
  HostCompatibilityDescriptorV1,
  HostCompatibilityDiagnosticCode,
} from './contracts/host-compatibility';
export {
  loadProductMeaningProvider,
  productMeaningProviderEntryPath,
  resolveAppRoot,
} from './runtime/product-meaning-provider';
export type {
  AppRootResolution,
  ProductMeaningProviderFailureCode,
  ProductMeaningProviderRef,
  ProductMeaningProviderResolution,
} from './runtime/product-meaning-provider';
export { TOOLKIT_NAME, TOOLKIT_VERSION } from './version';
export {
  DEFAULT_READINESS_DEADLINE_MS,
  launchOwnedServer,
  resolveNextBinary,
} from './runtime/launch';
export type {
  LaunchFailure,
  LaunchOwnedServerOptions,
  LaunchResult,
  LaunchSuccess,
} from './runtime/launch';
export { waitForHttpReadiness } from './runtime/readiness';
export type { ReadinessProbeInput, ReadinessResult } from './runtime/readiness';
export {
  getOwnProcessGroupId,
  isPortOpen,
  terminateProcessGroup,
  waitForPortClosed,
} from './runtime/process-group';
export type { ProcessGroupTermination, TerminateOptions } from './runtime/process-group';
export { generateRunId } from './runtime/run-id';
export {
  OWNED_CONFIG_FILES,
  digestOfFile,
  restoreRepoConfig,
  sha256OfBytes,
  snapshotRepoConfig,
} from './runtime/config-snapshot';
export type {
  RepoConfigFileRestore,
  RepoConfigRestoreAction,
  RestoreResult,
} from './runtime/config-snapshot';
export type { RepoConfigFileSnapshot, RepoConfigSnapshot } from './contracts/runtime';
export { deriveLaunchability } from './planner/launchability';
export {
  EXIT_CODES,
  buildCliResult,
  emitCliResult,
  exitCodeForOutcome,
  parseCliResultEnvelope,
  statusForOutcome,
  usageDiagnostic,
} from './cli/output';
export type { BuildCliResultInput } from './cli/output';
export { parseArgs } from './cli/args';
export type { ParsedArgs } from './cli/args';
export { runValidateAll } from './cli/validate';
export type { ValidateAllDetails, ValidatedCoverageModel } from './cli/validate';
export { runPlan } from './cli/plan';
export type { PlanDetails, RunPlanInput } from './cli/plan';
export { runCleanupCommand } from './cli/cleanup';
export type { CleanupCliDetails } from './cli/cleanup';
export {
  DEFAULT_TERMINATION_CLEANUP_DEADLINE_MS,
  SIGNAL_EXIT_CODES,
  TERMINATION_SIGNALS,
  getActiveRunId,
  installTerminationSignalHandlers,
  runTerminationCleanup,
  setActiveRun,
} from './cli/termination';
export type { TerminationSignal } from './cli/termination';

// ── Read-only Doctor and observation bridge v2 evidence (TS-3, Gate C/D) ─────
export {
  DOCTOR_ROUTE,
  DOCTOR_TITLE,
  EXPECTED_BRIDGE_VERSION,
  REQUIRED_STAGE_LAYERS,
  buildDoctorBridgeInspectionScript,
  closeBrowserSession,
  compareObservedEnvironmentToCell,
  observeBrowserEnvironmentFacts,
  runDoctor,
} from './browser/doctor';
export type {
  BrowserCloseOutcome,
  DoctorAppRevisionFactsInput,
  DoctorRegistryFactsInput,
  DoctorRunResult,
  RunDoctorInput,
} from './browser/doctor';
export { runDoctorCommand } from './cli/doctor';
export type { DoctorCliDetails, RunDoctorCommandInput } from './cli/doctor';

// ── Gated one-shot setup boundary seam contract (TS-3, Gate C) ────────────────
export {
  OBSERVATION_BRIDGE_READ_ONLY_METHODS,
  OBSERVATION_BRIDGE_VERSION,
  OBSERVATION_CURSOR_INVALIDATION_REASONS,
  OBSERVATION_CURSOR_SCHEMA_VERSION,
  OBSERVATION_GLOBAL_NAME,
  SETUP_AUTHORIZATION_STATES,
  SETUP_AUTHORIZATION_TOKEN_PATTERN,
  SETUP_BOUNDARY_STATES,
  SETUP_BROKER_KEY_DESCRIPTION,
  SETUP_CONSTRUCTOR_IDS,
  SETUP_CONSTRUCTION_LIFECYCLE_TRACE,
  SETUP_EVIDENCE_ROLE,
  SETUP_FORBIDDEN_TRANSPORT_CHANNELS,
  SETUP_GLOBAL_NAME,
  SETUP_LIFECYCLE_STATES,
  SETUP_RECORD_FORBIDDEN_KEYS,
  SETUP_REFUSAL_CODES,
  SETUP_ROUTE,
  SETUP_SCOPE_DIMENSIONS,
  SETUP_SEAL_RECORD_KEYS,
  SETUP_SEAM_SCHEMA_VERSION,
  isSetupRefusalCode,
  looksLikeSetupAuthorizationToken,
  setupFactsProvideCapabilityEvidence,
  setupRefusalDiagnostic,
  setupSealRecordViolations,
  setupTransportLeaks,
} from './contracts/seam';
export type {
  ObservationBridgeMethod,
  ObservationCursorInvalidationReason,
  SetupAuthorization,
  SetupAuthorizationState,
  SetupBoundaryState,
  SetupConstructRequest,
  SetupForbiddenTransportChannel,
  SetupLifecycleState,
  SetupRefusal,
  SetupRefusalCode,
  SetupScope,
  SetupScopeDimension,
  SetupSealRecord,
  SetupStatusFacts,
} from './contracts/seam';
export {
  buildSetupBrokerPresenceScript,
  buildSetupCapabilityDeliveryScript,
  buildSetupConstructorInvocationScript,
  buildSetupRefusalsScript,
  buildSetupSealRecordScript,
  buildSetupStatusScript,
  buildSetupTransportScanScript,
  createSetupAuthorization,
  deliverSetupAuthorization,
  invokeSetupConstructor,
  readSetupPageChannels,
  readSetupRefusals,
  readSetupSealRecord,
  readSetupStatus,
  setupBrokerIsPresent,
  SETUP_SCANNED_CHANNELS,
} from './browser/seam';
export type {
  CreateSetupAuthorizationInput,
  SetupCapabilityDelivery,
  SetupConstructorOutcome,
} from './browser/seam';

// ── Production seam-absence contract (specification 16 Gate C; TS-3) ─────────
export {
  CURSOR_DISCRIMINANT_MARKER,
  DOCUMENT_ANCHOR_SYMBOL_KEY,
  EXECUTABLE_ARTIFACT_EXTENSIONS,
  GENERATED_VECTOR_AUTHORITY_MARKER,
  GENERATED_VECTOR_PROJECTION_METHOD_MARKER,
  MANIFEST_ARTIFACT_EXTENSION,
  OBSERVATION_GLOBAL_MARKER,
  PRODUCTION_ABSENCE_MARKERS,
  PRODUCTION_ABSENCE_ROUTE,
  PRODUCTION_ABSENCE_SCHEMA_VERSION,
  PRODUCTION_ARTIFACT_SCAN_SCHEMA_VERSION,
  PRODUCTION_BROWSER_ABSENCE_SCHEMA_VERSION,
  RASTER_SCHEMA_DISCRIMINANT_MARKER,
  SCAN_SKIPPED_DIRECTORY_NAMES,
  SCAN_SKIPPED_SUFFIXES,
  SEAM_REQUEST_PATH_PATTERNS,
  SETUP_ANCHOR_SYMBOL_KEY,
  SETUP_BROKER_SYMBOL_KEY,
  SETUP_GLOBAL_MARKER,
  SIGNAL_ANCHOR_SYMBOL_KEY,
  evaluateProductionAbsence,
  evaluateProductionBrowserAbsence,
  isScannedArtifact,
  isSkippedDirectoryName,
  productionAbsenceDiagnostic,
  scanArtifactContent,
  seamRequestPaths,
} from './contracts/production-absence';
export type {
  AbsenceMarker,
  AbsenceMarkerCategory,
  ProductionAbsenceProofInput,
  ProductionAbsenceVerdict,
  ProductionArtifactHit,
  ProductionArtifactScan,
  ProductionBrowserObservation,
} from './contracts/production-absence';
export { scanProductionArtifacts } from './runtime/static-scan';
export {
  buildProductionAbsenceProbeScript,
  proveProductionAbsenceInBrowser,
} from './browser/production-absence';
export { reconcileRequestedChunks } from './cli/production-absence';

// ── WP5 Slice 5-A: adapter/workflow/readiness/Oracle tracer surface ───────────
export {
  TARGET_LAYOUT_ROLES,
  TARGET_RESOLUTION_DIAGNOSTIC,
  TARGET_RESOLUTION_STATUSES,
  targetResolutionDiagnostic,
} from './contracts/adapter';
export type {
  AdapterDiagnostics,
  AdapterElementFact,
  AdapterNormalizedResult,
  AdapterObservationVariable,
  AdapterPreconditionInput,
  AdapterPreconditionProblem,
  AdapterReadinessContribution,
  AdapterResolveTargetsInput,
  ResolvedTarget,
  SemanticTargetRole,
  SubjectAdapter,
  TargetGeometryFacts,
  TargetLayoutRole,
  TargetResolution,
  TargetResolutionStatus,
} from './contracts/adapter';
export {
  WAKE_SOURCES,
  cursorKey,
  cursorsEqual,
} from './contracts/observation';
export type {
  ObservationCursor,
  WaitForChangeOutcome,
  WaitForChangeStatus,
  WakeSource,
} from './contracts/observation';
export { bindingFixtureKey } from './contracts/fixtures';
export type { BindingFixture, BindingFixtureCatalogue } from './contracts/fixtures';
export {
  WORKFLOW_PRIMITIVES,
  WORKFLOW_STEP_KEYS,
  WORKFLOW_STEP_PARAMETER_KEYS,
} from './contracts/workflows';
export type {
  WorkflowPrimitive,
  WorkflowStep,
  WorkflowStepCatalogue,
  WorkflowStepEntry,
  WorkflowStepParameterBinding,
} from './contracts/workflows';
export {
  FixtureCatalogueError,
  parseBindingFixtureCatalogue,
  resolveBindingFixture,
} from './catalogue/fixtures';
export type { FixtureCatalogueErrorCode } from './catalogue/fixtures';
export {
  WORKFLOW_STEP_FORBIDDEN_KEYS,
  WorkflowStepError,
  parseWorkflowStepCatalogue,
  resolveWorkflowSteps,
} from './workflows/steps';
export type { WorkflowStepErrorCode } from './workflows/steps';
export {
  ADAPTER_IMPLEMENTATIONS,
  resolveAdapterImplementation,
} from './adapters/registry';
export type { AdapterRegistryInput, AdapterRegistryResult } from './adapters/registry';
export { textSpecializedAdapter } from './adapters/text-specialized';
export { executeWorkflowSteps } from './workflows/execute';
export type {
  ControlActivateRequest,
  ExecuteWorkflowStepsInput,
  ExecuteWorkflowStepsResult,
  FileInputSetRequest,
  KeyboardPressRequest,
  PointerClickRequest,
  PointerDragRequest,
  StepActionLog,
  WorkflowPrimitiveHandlers,
} from './workflows/execute';
export {
  ACTION_CYCLE_V1_PROFILE,
  awaitCausalTransition,
} from './readiness/correlated-gate';
export type {
  CausalPredicateResult,
  CorrelatedGateDeps,
  CorrelatedGateResult,
  ReadinessEvent,
  ReadinessEventKind,
  ReadinessProfile,
} from './readiness/correlated-gate';
export {
  captureCoherentObservation,
  rendererFingerprintStable,
} from './readiness/coherent-capture';
export type {
  BridgeRendererProvenance,
  BridgeRendererTargetProvenance,
  CoherentCaptureDeps,
  CoherentCaptureResult,
  CoherentObservation,
  StableRendererFingerprint,
  StampedGeometryView,
  StampedSnapshotView,
  TornObservation,
  TornReason,
} from './readiness/coherent-capture';
export {
  CANONICAL_EXACT_TOLERANCE,
  GEOMETRY_ORACLE_PROFILE,
  RENDER_TRANSFORM_CSS_TOLERANCE,
  evaluateGeometryDeltaOracle,
  findCanonicalPosition,
  renderedPosition,
  renderedTransformPosition,
  subtractPosition,
} from './oracles/geometry';
export type {
  GeometryDelta,
  GeometryDeltaOracleInput,
  GeometryDeltaOracleResult,
  GeometryPosition,
  MinimumDelta,
} from './oracles/geometry';
export {
  ORACLE_PROFILE,
  WARPED_ORACLE_PROFILE_ID,
  evaluateRequiredChecks,
  readMinimumDelta,
} from './oracles/evaluate';
export type {
  OracleEvaluation,
  OracleEvaluationInput,
  OracleGeometrySource,
  OracleTarget,
} from './oracles/evaluate';
export {
  WARPED_PRIMITIVE_AUTHORITIES,
  WARPED_TEXT_ORACLE_PROFILE,
  WARPED_TEXT_ORACLE_PROFILE_ID as WARPED_TEXT_PROFILE_ID,
  evaluateWarpedTextOracle,
  findWarpedCanonicalLayer,
} from './oracles/warped-text';
export type {
  WarpedCanonicalLayer,
  WarpedDeltaEvidence,
  WarpedEnvelopeEvidence,
  WarpedGeometrySource,
  WarpedOracleEvaluation,
  WarpedPrimitiveAuthority,
  WarpedPrimitiveCheckFact,
  WarpedPrimitiveFacts,
  WarpedPrimitiveMeasurements,
  WarpedPrimitiveTolerances,
  WarpedRequiredCheckId,
  WarpedTextOracleInput,
} from './oracles/warped-text';
export {
  CIRCLE_CONTROL_ENVELOPE_KIND,
  CIRCLE_CONTROL_ENVELOPE_POINT_ORDER,
  CIRCLE_TEXT_FRAME_PROJECTION_KIND,
  GEOMETRY_BRIDGE_VERSION,
  GEOMETRY_SCHEMA_VERSION,
  canonicalCircleControlEnvelopeLayoutQuad,
  canonicalCircleControlToLayoutMatrix,
  computeCircleWarpFingerprint,
  computeRepresentationFingerprint,
  validateCircleTextFrameProjection,
  validateTypedGeometry,
} from './contracts/geometry-v2';
export type {
  Affine2D,
  CircleControlEnvelopeQuadV1,
  CircleTextFrameProjectionV1,
  GeometryContractFailure,
  TypedGeometryResult,
  TypedRendererProvenanceV2,
} from './contracts/geometry-v2';
export { runActionCycle } from './runtime/action-cycle';
export type {
  ActionCycleBaseline,
  ActionCycleDeps,
  ActionCycleResult,
  ActionCycleTimings,
  ActionDispatchResult,
  IdleObservationResult,
} from './runtime/action-cycle';
export { executePlan } from './runtime/execute-plan';
export type {
  DiagnosticBridgeElements,
  DiagnosticBridgeSnapshot,
  ExecutePlanBehavior,
  ExecutePlanInput,
  ExecutePlanResult,
} from './runtime/execute-plan';
export {
  OWNERSHIP_RECORD_FINGERPRINT_DOMAIN,
  PUBLIC_PATH_REF_DOMAIN,
  PUBLIC_PATH_ROLES,
  PublicPathError,
  buildCleanupProjection,
  buildEstablishedOwnership,
  buildNotEstablishedOwnership,
  buildPublicLaunchFacts,
  normalizeLexicalAbsolutePath,
  ownershipRecordFingerprint,
  publicPathFingerprint,
  redactDiagnostics,
  redactRecordText,
  validateArtifactBasename,
  validatePublicRelativePath,
  historyEvidenceViolations,
} from './evidence/public-dto';
export type {
  PublicCleanupProjection,
  PublicLaunchFacts,
  PublicOwnershipEstablished,
  PublicOwnershipNotEstablished,
  PublicOwnershipProjection,
  PublicPathProjection,
  PublicPathRef,
  PublicPathRole,
  PublicHistoryEvidenceV1,
  PublicHistoryActionEvidenceV1,
  PublicHistorySetupCheckpointV1,
  PublicSelectionClearEvidenceV1,
  RunRecordFingerprints,
  RunRecordReadiness,
} from './evidence/public-dto';
export {
  RedactionRejectedError,
  assertPublicRecordSafe,
  isRedactionRejected,
  serializePublicRecord,
  textContainsProhibitedValue,
} from './evidence/guard';
export type { GuardOptions, RedactionFailure, RedactionFailureCode } from './evidence/guard';
export {
  captureCleanupAuthoritySnapshot,
  sensitiveGuardPaths,
} from './evidence/cleanup-authority';
export type { CleanupAuthoritySnapshot } from './evidence/cleanup-authority';
export {
  INTERACTION_TARGET,
  insetRegion,
  isPointInsideRegion,
  verifyInteractionTarget,
} from './browser/public-controls';
export type {
  InteractionPoint,
  InteractionRegion,
  InteractionTargetCandidate,
  InteractionTargetVerdict,
} from './browser/public-controls';
export { pointerClick, pointerDrag } from './browser/primitives';
export type {
  NativePointerClickInput,
  NativePointerClickResult,
  NativePointerDragInput,
  NativePointerDragResult,
  PointerActionLog,
} from './browser/primitives';
export { runDiagnosticCommand } from './cli/diagnostic';
export type { DiagnosticCliDetails, RunDiagnosticCommandInput } from './cli/diagnostic';
// ── ADR 0019 R12–R14: representative Diagnostic suite ────────────────────────
export { runDiagnosticSuiteCommand } from './cli/suite';
export type {
  DiagnosticSuiteCliDetails,
  RunDiagnosticSuiteInput,
  SuiteChildSummary,
} from './cli/suite';
export {
  DIAGNOSTIC_SUITE_IDS,
  DIAGNOSTIC_SUITE_REQUEST_PREFIX,
  REPRESENTATIVE_SUITE_CASE_COUNT,
  REPRESENTATIVE_SUITE_ID,
  DiagnosticSuiteValidationError,
  deriveDiagnosticSuiteFingerprint,
  diagnosticSuiteRequestProblem,
  isDiagnosticSuiteId,
  parseDiagnosticSuite,
  suiteLineageViolations,
} from './contracts/suite';
export type {
  DiagnosticSuiteCaseV1,
  DiagnosticSuiteId,
  DiagnosticSuiteV1,
  DiagnosticSuiteValidationCode,
  PublicSuiteLineageV1,
} from './contracts/suite';
export {
  SUITE_DECLARATION_FILES,
  loadDiagnosticSuite,
  resolveSuiteRequests,
} from './catalogue/suite';
export type {
  LoadDiagnosticSuiteOptions,
  LoadedDiagnosticSuite,
  ResolvedSuiteRequest,
} from './catalogue/suite';
export {
  deriveLaunchability as deriveStageAccurateLaunchability,
  resolveBindingDelivery,
} from './planner/launchability';
export type { BindingDelivery, BindingDeliveryInput } from './planner/launchability';
export { deriveWorkflowStepCatalogueFingerprint } from './catalogue/fingerprint';

// ── ADR 0017 R11/R12: raster schema v3 closed union and generated-vector arm ──
export {
  ARTWORK_VERIFICATION_RASTER_LEGACY_SCHEMA_VERSION,
  ARTWORK_VERIFICATION_RASTER_SCHEMA_VERSION,
  GENERATED_VECTOR_COORDINATE_SPACE,
  GENERATED_VECTOR_PROJECTION_METHOD,
  GENERATED_VECTOR_PROJECTION_PIXEL_RATIO,
  RASTER_AUTHORITY_KINDS,
  RASTER_PROBE_SET,
  RASTER_PROBE_SET_ID,
  RASTER_STATUSES,
  generatedVectorProjectionQuantization,
  rasterProbeBackingCoordinate,
  readAcceptedRasterAuthority,
  validateRasterRecord,
} from './contracts/raster';
export type {
  GeneratedVectorProjectionQuantization,
  GeneratedVectorRasterCaptureView,
  GeneratedVectorRasterRecordView,
  GeneratedVectorRasterRegionView,
  GeneratedVectorRasterRenderedView,
  ImageRasterRecordView,
  RasterAuthorityKind,
  RasterCaptureView,
  RasterObservationView,
  RasterProbeDefinition,
  RasterProbeResultView,
  RasterProbeRational,
  RasterRecordView,
  RasterRenderedView,
  RasterRendererView,
  RasterSourceView,
  RasterStatus,
  RasterV3HeaderView,
  RasterValidationResult,
} from './contracts/raster';

// ── ADR 0017: deterministic generated Crossword contracts ─────────────────────
export {
  CROSSWORD_DEFAULT_WORDS,
  CROSSWORD_DIRECTIONS,
  CROSSWORD_GENERATOR_SOURCE_PATH,
  CROSSWORD_SEMANTIC_DIGEST_DOMAIN,
  CROSSWORD_SEMANTIC_SCHEMA_VERSION,
  CROSSWORD_STORE_SOURCE_PATH,
  compareCrosswordRepresentative,
  compareCrosswordExecutions,
  crosswordSemanticDigest,
  crosswordSemanticPayloadFromLayerShape,
  crosswordWordsFingerprint,
  validateCrosswordLayoutStructure,
  validateCrosswordSourceContract,
} from './contracts/crossword';
export type {
  CrosswordCellV1,
  CrosswordChildComparisonFact,
  CrosswordChildComparisonRole,
  CrosswordDirection,
  CrosswordLayoutFactsV1,
  CrosswordLayoutSemanticV1,
  CrosswordPlacedWordV1,
  CrosswordRepresentativeComparison,
  CrosswordSourceContractFacts,
  CrosswordSourceContractResult,
  CrosswordStructuralFinding,
  CrosswordStructuralResult,
  CrosswordThreeChildComparison,
} from './contracts/crossword';
export {
  CROSSWORD_CLOCK_BASELINE_COUNT,
  CROSSWORD_CLOCK_PROFILE_ID,
  CROSSWORD_CLOCK_PROFILE_SCHEMA_VERSION,
  CROSSWORD_COMPARISON_PROFILE_ID,
  CROSSWORD_EXECUTION_ROLES,
  CROSSWORD_GENERATION_CAPTURE_PROFILE_ID,
  CROSSWORD_OBSERVATION_FINDING_CODES,
  CROSSWORD_OBSERVATION_SCHEMA_VERSION,
  CROSSWORD_RELEASE_EPOCHS,
  CROSSWORD_REQUIRED_CHECKS,
  CROSSWORD_SEMANTIC_PROFILE,
  crosswordWordsAreAuthoritative,
  isWellFormedObservationCursor,
  parseCrosswordClockProfile,
  validateCrosswordExecutionChild,
  validateCrosswordExecutionSet,
} from './contracts/crossword-observation';
export type {
  CrosswordClockFactsV1,
  CrosswordClockProfile,
  CrosswordClockValidation,
  CrosswordChildValidation,
  CrosswordExecutionChildInput,
  CrosswordExecutionRole,
  CrosswordExecutionSet,
  CrosswordExecutionSetInput,
  CrosswordExecutionSetValidation,
  CrosswordGenerationCurrentnessV1,
  CrosswordObservationFinding,
  CrosswordObservationFindingCode,
  CrosswordRequiredCheck,
  CrosswordTransitionFactsV1,
  ValidatedCrosswordExecution,
} from './contracts/crossword-observation';
export {
  WALL_CLOCK_NAMESPACE,
  WALL_CLOCK_PROVIDER_ID,
  WALL_CLOCK_PROVIDER_IMPLEMENTATION,
  validateWallClockBaseline,
} from './contracts/wall-clock';
export type { WallClockBaselineValidation } from './contracts/wall-clock';
export {
  CROSSWORD_ORACLE_PROFILE_ID,
  CROSSWORD_ORACLE_PROFILE_VERSION,
  evaluateCrosswordOracle,
} from './oracles/crossword';
export type {
  CrosswordOracleEvaluation,
  CrosswordOracleInput,
} from './oracles/crossword';
export {
  CROSSWORD_ADAPTER_REQUIRED_CHECKS,
  CROSSWORD_GENERATION_READINESS_PROFILE,
  CROSSWORD_ORACLE_PROFILE,
  GENERATED_CROSSWORD_SEMANTIC_PROFILE,
  GENERATED_SPECIALIZED_ADAPTER_ID,
  GENERATED_SPECIALIZED_COMPATIBILITY_VERSION,
  generatedSpecializedAdapter,
} from './adapters/generated-specialized';
export {
  DELIVERED_EXECUTION_ADAPTERS,
  resolveExecutionSupport,
} from './planner/execution-support';
export type { ExecutionSupportDecision } from './planner/execution-support';
// ── P8-B evidence verifier public surface (ADR 0048 WP-B2) ────────────────────
//
// Exported for the tested public verifier contract only. The verifier is
// read-only audit tooling: it is not an active producer, final authority, or
// CLI activation edge, and it exposes no write, cleanup, approval, adoption, or
// evidence-mutation surface.
export {
  ADVISORY_VERIFIER_CODES,
  EVIDENCE_VERIFY_ARGUMENT_FAILURES,
  EVIDENCE_VERIFY_CHECK_IDS,
  EVIDENCE_VERIFY_CODES,
  EVIDENCE_VERIFY_DETAIL_CODES,
  EVIDENCE_VERIFY_REPORT_LABEL,
  EVIDENCE_VERIFY_SCHEMA_VERSION,
  PRIMARY_BLOCKING_VERIFIER_CODES,
  parseEvidenceVerifyArguments,
  parseEvidenceVerifyDetails,
  validateEvidenceVerifyDetails,
} from './contracts/evidence-verify';
export type {
  EvidenceVerifyArgumentFailure,
  EvidenceVerifyArgumentsResult,
  EvidenceVerifyCode,
  EvidenceVerifyDetails,
  EvidenceVerifyDiagnostic,
  EvidenceVerifySuite,
  EvidenceVerifyTransaction,
} from './contracts/evidence-verify';
export {
  EvidenceVerifyExternalFsError,
  EvidenceVerifyNoFollowUnsupportedError,
  EvidenceVerifyRequestError,
  createCurrentTreeProvenanceProvider,
  createNodeEvidenceVerifyFsAdapter,
  detectNodeNoFollowCapability,
  isEvidenceVerifyExternalFsError,
  verifyEvidenceRoot,
} from './evidence/integrity';
export type {
  CurrentTreeProvenanceProviderOptions,
  EvidenceVerifyCurrentTreeContext,
  EvidenceVerifyCurrentTreeSignals,
  EvidenceVerifyEnvironment,
  EvidenceVerifyFsAdapter,
  EvidenceVerifyRequest,
} from './evidence/integrity';
export { EVIDENCE_VERIFY_DETAILS, runEvidenceVerifyCommand } from './cli/evidence';
export type { EvidenceVerifyCommandOptions } from './cli/evidence';
