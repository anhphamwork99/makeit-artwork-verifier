import type { ExecutableSelectionManifestDraftV1 } from './executable-selection-manifest';
import type { GovernanceTimingV1 } from './governance-timing';
import type { EnvironmentCell } from './runtime';

export const QUALIFICATION_RUNTIME_SCHEMA_VERSION = 1 as const;
export const QUALIFICATION_ATTEMPTS_PER_CELL = 3 as const;
export const QUALIFICATION_BATCH_ID_PATTERN = /^qbatch-[0-9a-f-]{36}$/;

export interface QualificationSlotV1 {
  readonly ordinal: number;
  readonly instanceId: string;
  readonly runId: string;
  readonly entryId: string;
  readonly cell: EnvironmentCell;
  readonly requestDigest: string;
  readonly caseId: string;
  readonly materializationFingerprint: string;
  readonly planFingerprint: string;
  readonly executionProfileIdentity: string;
}

export interface QualificationBatchV1 {
  readonly schemaVersion: typeof QUALIFICATION_RUNTIME_SCHEMA_VERSION;
  readonly batchId: string;
  readonly batchFingerprint: string;
  readonly manifestId: string;
  readonly manifestFingerprint: string;
  readonly candidate: ExecutableSelectionManifestDraftV1;
  readonly requiredCellIds: readonly string[];
  readonly selectedEntryIds: readonly string[];
  readonly selectionRationale: string;
  readonly sourceProvenanceDigest: string;
  readonly slots: readonly QualificationSlotV1[];
  readonly predecessorBatchId: string | null;
  readonly correctionRationale: string | null;
}

export type QualificationFailureCode =
  | 'CANDIDATE_INVALID'
  | 'CANDIDATE_DRIFT'
  | 'ENTRY_SELECTION_INVALID'
  | 'PLAN_DRIFT'
  | 'SOURCE_DRIFT'
  | 'LEDGER_INVALID'
  | 'BATCH_ALREADY_CONSUMED'
  | 'CHILD_RECORD_INVALID'
  | 'CHILD_OUTCOME_NON_PASS'
  | 'CLEANUP_INVALID'
  | 'EVIDENCE_INVALID'
  | 'TIMING_INVALID'
  | 'EXECUTION_INTERRUPTED';

export type QualificationLedgerEventV1 =
  | { readonly type: 'batch-predeclared'; readonly batch: QualificationBatchV1 }
  | { readonly type: 'batch-started'; readonly batchFingerprint: string }
  | {
      readonly type: 'instance-started';
      readonly ordinal: number;
      readonly instanceId: string;
      readonly runId: string;
    }
  | {
      readonly type: 'instance-finished';
      readonly ordinal: number;
      readonly instanceId: string;
      readonly runId: string;
      readonly outcome: 'PASS' | 'BUG' | 'HARNESS_BLOCKED' | 'ENVIRONMENT_FAILURE' | null;
      readonly recordDigest: string | null;
      readonly evidenceDigest: string | null;
      readonly evidenceVerified: boolean;
      readonly cleanupVerified: boolean;
      readonly failureCode: QualificationFailureCode | null;
      /** Absent only in retained pre-WP1 history or a run with an invalid clock. */
      readonly timing?: GovernanceTimingV1;
    }
  | {
      readonly type: 'batch-assessed';
      readonly state: 'REVIEW_READY' | 'FAILED' | 'INTERRUPTED';
      readonly failureCode: QualificationFailureCode | null;
      readonly completedAttemptCount: number;
      readonly releaseCredit: false;
      /** Absent only in retained pre-WP1 history or a run with an invalid clock. */
      readonly timing?: GovernanceTimingV1;
    };

export interface QualificationLedgerRecordV1 {
  readonly schemaVersion: typeof QUALIFICATION_RUNTIME_SCHEMA_VERSION;
  readonly batchId: string;
  readonly sequence: number;
  readonly previousDigest: string | null;
  readonly event: QualificationLedgerEventV1;
  readonly digest: string;
}

export type QualificationBatchAssessment = 'REVIEW_READY' | 'FAILED' | 'INTERRUPTED';

export interface QualificationAttemptResult {
  readonly ordinal: number;
  readonly instanceId: string;
  readonly runId: string;
  readonly outcome: 'PASS' | 'BUG' | 'HARNESS_BLOCKED' | 'ENVIRONMENT_FAILURE' | null;
  readonly evidenceVerified: boolean;
  readonly cleanupVerified: boolean;
  readonly failureCode: QualificationFailureCode | null;
}

export interface QualificationRuntimeResult {
  readonly batchId: string;
  readonly batchFingerprint: string;
  readonly state: QualificationBatchAssessment;
  readonly failureCode: QualificationFailureCode | null;
  readonly attempts: readonly QualificationAttemptResult[];
  readonly releaseCredit: false;
}

export interface VerifiedQualificationBatchV1 {
  readonly batch: QualificationBatchV1;
  readonly finalLedgerDigest: string;
  readonly sourceProvenanceDigest: string;
  readonly slots: readonly {
    readonly ordinal: number;
    readonly entryId: string;
    readonly runId: string;
    readonly recordDigest: string;
    readonly evidenceDigest: string;
  }[];
}

export interface PrepareQualificationBatchInput {
  readonly draft: ExecutableSelectionManifestDraftV1;
  readonly entryIds: readonly string[];
  readonly selectionRationale: string;
  readonly predecessorBatchId?: string;
  readonly correctionRationale?: string;
}

export function isQualificationBatchId(value: unknown): value is string {
  return typeof value === 'string' && QUALIFICATION_BATCH_ID_PATTERN.test(value);
}
