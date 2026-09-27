import type {
  AllocationFailureReason,
  AllocationStatus,
  CaseProvenance,
  EvidenceDepth,
  ExecutionProfile,
  Outcome,
} from './discriminants';

/**
 * Attempt-specific execution contracts.
 *
 * `PlanIdentity` binds an attempt to the immutable plan. Ephemeral resources
 * (port, process group, `distDir`, evidence root) are deliberately outside the
 * plan fingerprint and are only ever carried by the allocation (decision 0007
 * N7/N9).
 */

export interface PlanIdentity {
  caseId: string;
  materializationFingerprint: string;
  planFingerprint: string;
}

export interface EphemeralResources {
  port: number;
  processGroupId: number;
  distDir: string;
  evidenceRoot: string;
}

export interface ExecutionAllocation {
  schemaVersion: number;
  allocationId: string;
  executionInstanceId: string;
  boundTo: PlanIdentity;
  ephemeral: EphemeralResources;
}

export interface ReservedAllocation {
  status: Extract<AllocationStatus, 'RESERVED'>;
  launchAttempted: false;
  allocation: ExecutionAllocation;
}

export interface FailedAllocation {
  status: Extract<AllocationStatus, 'ENVIRONMENT_FAILURE'>;
  launchAttempted: false;
  reason: AllocationFailureReason;
  detail: string;
}

export type AllocationResult = ReservedAllocation | FailedAllocation;

/**
 * Legacy boolean required-check record.
 *
 * E3-S2 makes the status-based three-state required check
 * (`contracts/correctness.ts` `CorrectnessCheckResult`, carried by the strict v4
 * child record) the sole current check authority. This boolean shape is retained
 * only because unchanged read-only consumers (`src/allocation/**` type-only
 * edges) and the unreachable legacy classifier still declare it; it is not
 * current authority and must never be read to derive a current status.
 *
 * @deprecated Legacy fixture type; not current authority (ADR 0031 §"Public
 * export closure").
 */
export interface CheckResult {
  checkId: string;
  passed: boolean;
}

/**
 * @deprecated Legacy boolean diagnostic-evidence record; not current authority.
 */
export interface DiagnosticEvidence {
  evidenceId: string;
  passed: boolean;
}

/**
 * Legacy boolean classifier inputs.
 *
 * E3-S2 removes this as active classification authority: the current path
 * derives status from the compiled-profile three-state checks, never from
 * `CheckResult.passed` or `harnessInvalid`. The shape is retained only for the
 * unreachable legacy classifier (`src/runtime/outcomes.ts`). Diagnostic evidence
 * is intentionally absent: deeper diagnostics can never satisfy, rescue,
 * extend, or override a required check (decision 0007 amendment 12).
 *
 * @deprecated Legacy boolean classification input; not current authority.
 */
export interface OutcomeInput {
  requiredChecks: readonly CheckResult[];
  cleanupSucceeded: boolean;
  /** Overlapping required sources disagreed; no source rescues another. */
  requiredSourcesAgree?: boolean;
  /** Trustworthy correctness evidence could not be produced or interpreted. */
  harnessInvalid?: boolean;
  /** External runtime or prerequisite failure prevented trustworthy completion. */
  environmentInvalid?: boolean;
}

/**
 * @deprecated Legacy boolean execution-instance record; the current execution
 * contract is the materialized execution envelope plus the status-based final
 * checks. Retained only for retained read-only consumers and test support.
 */
export interface ExecutionInstanceResult {
  executionInstanceId: string;
  caseId: string;
  materializationFingerprint: string;
  planFingerprint: string;
  profile: ExecutionProfile;
  provenance: CaseProvenance;
  evidenceDepth: EvidenceDepth;
  outcome: Outcome;
  requiredChecks: readonly CheckResult[];
  diagnosticEvidence: readonly DiagnosticEvidence[];
  cleanupSucceeded: boolean;
  predecessor: string | null;
}
