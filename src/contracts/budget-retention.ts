/**
 * Closed raw-evidence inventory records. These types describe preserved bytes;
 * they confer no evidence validity, current-lineage eligibility, or deletion
 * authority.
 */

export const RETENTION_SNAPSHOT_SCHEMA_VERSION = 1 as const;
export const RETENTION_AUDIT_SCHEMA_VERSION = 1 as const;
export const RETENTION_POLICY = 'PRESERVE_ALL' as const;

export const RETENTION_NAMESPACES = [
  'approvals',
  'budget-measurements',
  'budget-policies',
  'manifest-lifecycle',
  'proposals',
  'qualification-authority',
  'release-runs',
  'retention-audit',
  'run-evidence',
  'reviews',
  'suite-evidence',
] as const;

export type RetentionNamespace = (typeof RETENTION_NAMESPACES)[number];

export type RetentionRawContentStatus = 'JSON_PARSE_FAILED' | 'JSON_UNVERIFIED' | 'NON_JSON';

export type RetentionReferenceStatus =
  | 'DANGLING_REFERENCES'
  | 'NO_DECLARED_REFERENCES'
  | 'REFERENCES_RESOLVED'
  | 'REFERENCE_STATUS_UNASSESSED'
  | 'UNREFERENCED_OBJECT';

export type RetentionReferenceAnomalyCode = 'DANGLING_REFERENCE' | 'UNREFERENCED_OBJECT';

export interface RetentionReferenceAnomalyV1 {
  readonly code: RetentionReferenceAnomalyCode;
  /** Hash of the opaque object identity; never a local path or raw reference. */
  readonly objectId: string;
  /** Hash of the unresolved/reference token; never the token itself. */
  readonly referenceDigest: string | null;
}

export interface RetentionArtifactV1 {
  /** Stable opaque identity derived from namespace and scoped relative path. */
  readonly objectId: string;
  readonly namespace: RetentionNamespace;
  /** Relative only to the fixed namespace root; never an absolute path. */
  readonly relativePath: string;
  readonly byteCount: number;
  readonly sha256: string;
  readonly rawContentStatus: RetentionRawContentStatus;
  readonly referenceStatus: RetentionReferenceStatus;
  readonly referenceAnomalies: readonly RetentionReferenceAnomalyV1[];
  readonly disposition: typeof RETENTION_POLICY;
}

export interface RetentionNamespaceWatermarkV1 {
  readonly namespace: RetentionNamespace;
  readonly presence: 'ABSENT' | 'PRESENT';
  /** Opaque same-filesystem directory identity; unchanged by later file appends. */
  readonly rootIdentity: string | null;
  readonly fileCount: number;
  readonly byteCount: number;
  /** Digest of this namespace's sorted logical path/byte digest inventory. */
  readonly inventoryDigest: string;
}

export interface RetentionSnapshotV1 {
  readonly schemaVersion: typeof RETENTION_SNAPSHOT_SCHEMA_VERSION;
  readonly policy: typeof RETENTION_POLICY;
  readonly snapshotId: string;
  readonly capturedAt: string;
  readonly namespaceWatermarks: readonly RetentionNamespaceWatermarkV1[];
  readonly artifacts: readonly RetentionArtifactV1[];
  readonly totalFileCount: number;
  readonly totalByteCount: number;
  /** Digest of all snapshot fields except this digest. */
  readonly digest: string;
}

export interface RetentionAuditRecordV1 {
  readonly schemaVersion: typeof RETENTION_AUDIT_SCHEMA_VERSION;
  readonly auditId: string;
  readonly snapshot: RetentionSnapshotV1;
  /** Digest of the audit fields except this digest. */
  readonly digest: string;
}

export type RetentionFailureCode =
  | 'AUDIT_INVALID'
  | 'AUDIT_NOT_FOUND'
  | 'AUDIT_WRITE_REFUSED'
  | 'INVENTORY_LIMIT_EXCEEDED'
  | 'NO_FOLLOW_UNAVAILABLE'
  | 'ROOT_INVALID'
  | 'SNAPSHOT_CHANGED'
  | 'UNSAFE_FILESYSTEM_OBJECT'
  | 'UNSAFE_LOGICAL_PATH';

export type RetentionResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: RetentionFailureCode };

export interface RetentionInventoryOptions {
  /** Fixed-clock injection for deterministic tests; production uses current UTC. */
  readonly capturedAt?: string;
  readonly maxFiles?: number;
  readonly maxDepth?: number;
  readonly maxFileBytes?: number;
  readonly maxTotalBytes?: number;
}

export type RetentionAuditOptions = RetentionInventoryOptions;

/** No-credit, pre-activation full-scope Diagnostic calibration ledger. */
export const DIAGNOSTIC_CALIBRATION_SCHEMA_VERSION = 1 as const;
export const DIAGNOSTIC_CALIBRATION_METHOD = 'full-manifest-diagnostic-v1' as const;
export const DIAGNOSTIC_CALIBRATION_ID_PATTERN = /^cal-[0-9a-f-]{36}$/;

export type CalibrationFailureCode =
  | 'CANDIDATE_INVALID'
  | 'CANDIDATE_DRIFT'
  | 'SOURCE_DRIFT'
  | 'PLAN_DRIFT'
  | 'LEDGER_INVALID'
  | 'CALIBRATION_CONSUMED'
  | 'CHILD_RECORD_INVALID'
  | 'CHILD_OUTCOME_INVALID'
  | 'CLEANUP_INVALID'
  | 'EVIDENCE_INVALID'
  | 'TIMING_INVALID'
  | 'EXECUTION_INTERRUPTED';

export interface DiagnosticCalibrationSlotV1 {
  readonly order: number;
  readonly entryId: string;
  readonly cell: import('./runtime').EnvironmentCell;
  readonly instanceId: string;
  readonly runId: string;
  readonly requestDigest: string;
  readonly caseId: string;
  readonly materializationFingerprint: string;
  readonly planFingerprint: string;
  readonly executionProfileIdentity: string;
}

export interface DiagnosticCalibrationV1 {
  readonly schemaVersion: typeof DIAGNOSTIC_CALIBRATION_SCHEMA_VERSION;
  readonly method: typeof DIAGNOSTIC_CALIBRATION_METHOD;
  readonly calibrationId: string;
  /** Path scoped only to cases/selection-manifests/drafts. */
  readonly draftReference: string;
  readonly draftBytesDigest: string;
  readonly manifestId: string;
  readonly manifestFingerprint: string;
  readonly candidate: import('./executable-selection-manifest').ExecutableSelectionManifestDraftV1;
  readonly requiredCell: import('./runtime').EnvironmentCell;
  readonly sourceProvenanceDigest: string;
  readonly slots: readonly DiagnosticCalibrationSlotV1[];
  readonly shardPlanFingerprint: string;
}

export type DiagnosticCalibrationEventV1 =
  | { readonly type: 'calibration-predeclared'; readonly calibration: DiagnosticCalibrationV1 }
  | { readonly type: 'calibration-started'; readonly calibrationFingerprint: string }
  | {
      readonly type: 'slot-started';
      readonly order: number;
      readonly instanceId: string;
      readonly runId: string;
    }
  | {
      readonly type: 'slot-finished';
      readonly order: number;
      readonly instanceId: string;
      readonly runId: string;
      readonly outcome: 'PASS' | 'BUG' | 'HARNESS_BLOCKED' | 'ENVIRONMENT_FAILURE' | null;
      readonly cliStatus: 'PASS' | 'BUG' | 'HARNESS_BLOCKED' | 'ENVIRONMENT_FAILURE' | null;
      readonly recordDigest: string | null;
      readonly evidenceDigest: string | null;
      readonly failureCode: CalibrationFailureCode | null;
      readonly cleanupVerified: boolean;
      readonly evidenceVerified: boolean;
      readonly evidenceFileCount: number;
      readonly evidenceByteCount: number;
      readonly evidenceFiles: readonly {
        readonly path: string;
        readonly byteCount: number;
        readonly sha256: string;
      }[];
      readonly evidenceFilesDigest: string;
      readonly timing?: import('./governance-timing').GovernanceTimingV1;
    }
  | {
      readonly type: 'calibration-assessed';
      readonly state: 'COMPLETE_ALL_PASS' | 'NON_CREDITABLE' | 'INTERRUPTED';
      readonly failureCode: CalibrationFailureCode | null;
      readonly completedCount: number;
      readonly unstartedOrders: readonly number[];
      readonly noReleaseCredit: true;
      readonly timing?: import('./governance-timing').GovernanceTimingV1;
    };

export interface DiagnosticCalibrationLedgerRecordV1 {
  readonly schemaVersion: typeof DIAGNOSTIC_CALIBRATION_SCHEMA_VERSION;
  readonly calibrationId: string;
  readonly sequence: number;
  readonly previousDigest: string | null;
  readonly event: DiagnosticCalibrationEventV1;
  readonly digest: string;
}

export interface PreparedDiagnosticCalibrationV1 {
  readonly calibration: DiagnosticCalibrationV1;
  /** In-memory compile-once candidates; never serialized into a ledger. */
  readonly preparedCandidates: readonly import('../cli/diagnostic').PreparedExecutionCandidate[];
}

export interface VerifiedDiagnosticCalibrationV1 {
  readonly calibration: DiagnosticCalibrationV1;
  readonly finalLedgerDigest: string;
  readonly state: 'COMPLETE_ALL_PASS' | 'NON_CREDITABLE' | 'INTERRUPTED';
  readonly timing: import('./governance-timing').GovernanceTimingV1 | null;
  readonly slots: readonly {
    readonly order: number;
    readonly runId: string;
    readonly outcome: 'PASS' | 'BUG' | 'HARNESS_BLOCKED' | 'ENVIRONMENT_FAILURE' | null;
    readonly recordDigest: string;
    readonly evidenceDigest: string;
    readonly evidenceFileCount: number;
    readonly evidenceByteCount: number;
  }[];
}

export type BudgetResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: CalibrationFailureCode };

/** Immutable, no-credit measurement of explicitly named current evidence. */
export const BUDGET_MEASUREMENT_SET_SCHEMA_VERSION = 1 as const;
export const BUDGET_MEASUREMENT_SET_ID_PATTERN = /^bset-[0-9a-f]{64}$/;
/** Explicit implementation methods; changing either requires a new reviewed version. */
export const BUDGET_MEASUREMENT_JOIN_METHOD =
  'fresh-qualification-calibration-retention-v1' as const;
export const BUDGET_MEASUREMENT_VERIFIER_METHOD =
  'strict-current-ledger-child-retention-v1' as const;

export interface BudgetMeasuredRunV1 {
  readonly runId: string;
  readonly entryId: string;
  readonly elapsedMs: number;
  readonly evidenceFileCount: number;
  readonly evidenceByteCount: number;
  /** Strict v4 Image projection only. Other selected families have no trusted counter. */
  readonly imageTornRecaptures: number | null;
  readonly imageApplicability: 'MEASURED' | 'UNAVAILABLE';
}

export interface BudgetFamilyMeasurementV1 {
  readonly family: 'image' | 'text' | 'object' | 'crossword' | 'history' | 'restore';
  readonly status: 'MEASURED' | 'UNAVAILABLE' | 'NOT_APPLICABLE';
  /** Present only when a strict persisted counter exists for the selected family. */
  readonly tornRecaptureCount: number | null;
  readonly reason: 'STRICT_V4_IMAGE_CYCLES' | 'NO_TRUSTED_V4_COUNTER' | 'NOT_IN_MANIFEST';
}

export interface BudgetMeasurementSetContentV1 {
  readonly schemaVersion: typeof BUDGET_MEASUREMENT_SET_SCHEMA_VERSION;
  readonly joinMethod: typeof BUDGET_MEASUREMENT_JOIN_METHOD;
  readonly verifierMethod: typeof BUDGET_MEASUREMENT_VERIFIER_METHOD;
  readonly calibrationId: string;
  readonly calibrationLedgerDigest: string;
  readonly qualificationBatchId: string;
  readonly qualificationLedgerDigest: string;
  readonly retentionAuditId: string;
  readonly retentionAuditDigest: string;
  readonly manifestId: string;
  readonly manifestFingerprint: string;
  readonly sourceProvenanceDigest: string;
  readonly requiredCellId: string;
  readonly calibrationElapsedMs: number;
  readonly qualificationElapsedMs: number;
  readonly calibrationRuns: readonly BudgetMeasuredRunV1[];
  readonly qualificationRuns: readonly BudgetMeasuredRunV1[];
  readonly families: readonly BudgetFamilyMeasurementV1[];
  readonly releaseCredit: false;
}

export interface BudgetMeasurementSetV1 {
  readonly schemaVersion: typeof BUDGET_MEASUREMENT_SET_SCHEMA_VERSION;
  readonly measurementSetId: string;
  readonly content: BudgetMeasurementSetContentV1;
  /** Canonical digest of the complete content; ID is derived from this digest. */
  readonly contentDigest: string;
}

export type BudgetMeasurementFailureCode =
  | 'INPUT_INVALID'
  | 'CALIBRATION_INVALID'
  | 'QUALIFICATION_INVALID'
  | 'RETENTION_INVALID'
  | 'LINEAGE_MISMATCH'
  | 'MEASUREMENT_INVALID'
  | 'MEASUREMENT_NOT_FOUND'
  | 'MEASUREMENT_WRITE_REFUSED';

export type BudgetMeasurementResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: BudgetMeasurementFailureCode };

/**
 * Closed, versioned no-credit **budget policy proposal** and its pure
 * `full-scope-envelope-v1` feasibility decision.
 *
 * Trust boundary (explicit): a proposal carries *only* reviewable claims about
 * one already-verified measurement set: the exact bound identities, the method,
 * the method-supported family applicability states, declared torn-counter
 * dependencies, and separately supplied finite ceilings. It never authors or
 * embeds an approval, never carries a default ceiling, and the pure checker
 * that consumes it re-reads no filesystem, does not establish that any ceiling
 * was independently reviewed, and does not prove the caller-supplied retained
 * byte count matches a retention snapshot.
 */
export const BUDGET_POLICY_SCHEMA_VERSION = 1 as const;
export const BUDGET_POLICY_METHOD = 'full-scope-envelope-v1' as const;

export type BudgetPolicyFailureCode =
  | 'POLICY_INVALID'
  | 'POLICY_UNSUPPORTED'
  | 'BINDING_MISMATCH'
  | 'MEASUREMENT_SHAPE_INVALID'
  | 'FAMILY_STATE_MISMATCH'
  | 'REQUIRED_IMAGE_UNMEASURED'
  | 'UNAVAILABLE_DEPENDENCY'
  | 'RETAINED_BYTES_INVALID'
  | 'LIMIT_EXCEEDED';

/** Method-supported applicability state for one family; never a numeric claim. */
export interface BudgetPolicyFamilyStateV1 {
  readonly family: BudgetFamilyMeasurementV1['family'];
  readonly status: 'MEASURED' | 'UNAVAILABLE' | 'NOT_APPLICABLE';
}

/**
 * Separately approved finite nonnegative ceilings. `release*` are the
 * Release-equivalent full-scope Diagnostic calibration duration/evidence-byte
 * ceilings; `qualification*` are the fixed-sample Qualification ceilings.
 * Durations are finite nonnegative; byte/count ceilings are safe integers.
 * `imageTornRecaptures` is a safe-integer count when Image is selected and
 * `null` when the manifest has no Image entry (manifest-derived
 * `not-applicable`). This contract supplies no default or real threshold value.
 */
export interface BudgetPolicyCeilingsV1 {
  readonly releaseDurationMs: number;
  readonly releaseEvidenceBytes: number;
  readonly qualificationDurationMs: number;
  readonly qualificationEvidenceBytes: number;
  readonly retainedEvidenceBytes: number;
  readonly imageTornRecaptures: number | null;
}

/** Closed `full-scope-envelope-v1` proposal bound to exactly one measurement set. */
export interface BudgetPolicyProposalV1 {
  readonly schemaVersion: typeof BUDGET_POLICY_SCHEMA_VERSION;
  readonly method: typeof BUDGET_POLICY_METHOD;
  /** No policy is approved or creditable by authoring a proposal. */
  readonly state: 'PROPOSED_NOT_APPROVED';
  readonly releaseCredit: false;
  /** Exact bound measurement-set identity and canonical content digest. */
  readonly measurementSetId: string;
  readonly measurementSetContentDigest: string;
  readonly retentionAuditId: string;
  readonly retentionAuditDigest: string;
  readonly manifestId: string;
  readonly manifestFingerprint: string;
  readonly sourceProvenanceDigest: string;
  readonly requiredCellId: string;
  /** Declared applicability for every one of the six families. */
  readonly familyStates: readonly BudgetPolicyFamilyStateV1[];
  /** Families whose persisted torn counter this method relies on; must equal the measured set. */
  readonly tornCounterDependencies: readonly BudgetFamilyMeasurementV1['family'][];
  readonly ceilings: BudgetPolicyCeilingsV1;
}

/** Observed dimensions the pure checker compares against the declared ceilings. */
export interface BudgetObservedDimensionsV1 {
  readonly releaseDurationMs: number;
  readonly releaseEvidenceBytes: number;
  readonly qualificationDurationMs: number;
  readonly qualificationEvidenceBytes: number;
  readonly retainedInventoryBytes: number;
  readonly imageTornRecaptures: number | null;
}

export type BudgetFeasibilityResultV1 =
  | {
      readonly ok: true;
      readonly decision: 'FEASIBLE';
      readonly observed: BudgetObservedDimensionsV1;
    }
  | { readonly ok: false; readonly code: BudgetPolicyFailureCode };

/**
 * Externally authored, read-only budget-policy authority artifacts.
 *
 * Trust boundary (explicit): these closed contracts describe three immutable
 * canonical JSON + trailing-LF files under
 * `evidence/governance/budget/policies/{proposals,reviews,approvals}/<id>.json`.
 * Verifying their bytes and internal joins proves only that the three records
 * are mutually self-consistent. It is *not* independent authority: ADR 0111
 * requires a separately controlled, runner-inaccessible trust registry that
 * pins the exact approved raw-byte digests before any credential is granted.
 * A same-user file, Git commit, chmod bit, boolean or CLI flag is not
 * authentication and must never be promoted to live authority.
 */
export const BUDGET_POLICY_ARTIFACT_SCHEMA_VERSION = 1 as const;
export const BUDGET_POLICY_DECISION_SCOPE = 'budget-policy' as const;
export const BUDGET_POLICY_MANDATE = 'ADR-0099' as const;
export const BUDGET_POLICY_DECISION_MAKER = 'delegated-owner / Codex orchestrator' as const;
export const BUDGET_POLICY_ARTIFACT_ID_PATTERN = /^budget-policy-[0-9a-f]{64}$/;

/** One canonical proposal artifact. Never authors or embeds an approval. */
export interface BudgetPolicyProposalArtifactV1 {
  readonly schemaVersion: typeof BUDGET_POLICY_ARTIFACT_SCHEMA_VERSION;
  readonly proposalId: string;
  readonly state: 'PROPOSED_NOT_APPROVED';
  readonly releaseCredit: false;
  readonly proposal: BudgetPolicyProposalV1;
  readonly rationale: string;
}

/** Independent review of one exact proposal artifact. */
export interface BudgetPolicyReviewArtifactV1 {
  readonly schemaVersion: typeof BUDGET_POLICY_ARTIFACT_SCHEMA_VERSION;
  readonly reviewId: string;
  readonly reviewer: string;
  readonly result: 'PASS';
  readonly proposalId: string;
  /** Raw SHA-256 of the exact proposal file bytes this review examined. */
  readonly proposalDigest: string;
  readonly rationale: string;
}

/** Delegated-owner decision binding both proposal and review exact bytes. */
export interface BudgetPolicyApprovalArtifactV1 {
  readonly schemaVersion: typeof BUDGET_POLICY_ARTIFACT_SCHEMA_VERSION;
  readonly approvalId: string;
  readonly decisionMaker: typeof BUDGET_POLICY_DECISION_MAKER;
  readonly mandate: typeof BUDGET_POLICY_MANDATE;
  /** Budget feasibility only; never Release activation/service allocation. */
  readonly decisionScope: typeof BUDGET_POLICY_DECISION_SCOPE;
  readonly proposalId: string;
  readonly proposalDigest: string;
  readonly reviewId: string;
  readonly reviewDigest: string;
  readonly rationale: string;
  readonly timestamp: string;
}

/**
 * Independent trust-root pins resolved outside the execution runner. A provider
 * that echoes a same-user file, Git commit, boolean or CLI flag is not
 * independent control and must not be wired as production authority.
 */
export interface BudgetPolicyAuthorityAttestationV1 {
  readonly decisionScope: typeof BUDGET_POLICY_DECISION_SCOPE;
  readonly proposalId: string;
  readonly proposalDigest: string;
  readonly reviewId: string;
  readonly reviewDigest: string;
  readonly approvalId: string;
  readonly approvalDigest: string;
}

export interface BudgetPolicyAuthorityProvider {
  /** Exact independent pins for one approval id, or `null` when unattested. */
  readonly resolve: (approvalId: string) => BudgetPolicyAuthorityAttestationV1 | null;
}

/** The only success decision this verifier can emit; it grants no credit. */
export const BUDGET_POLICY_VERIFIED_DECISION = 'POLICY_VERIFIED_NON_CREDITABLE' as const;
