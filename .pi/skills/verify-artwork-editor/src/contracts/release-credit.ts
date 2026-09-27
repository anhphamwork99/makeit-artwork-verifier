/**
 * Static Gate-G preparation only: nothing in this module executes a Release Run
 * or grants Release credit (production specification §13.4, Gate G).
 *
 * Every caller-supplied Gate-F status or approval label is an untrusted
 * hypothetical predicate input, never proof of an accepted gate or human
 * decision. The assessment therefore always returns `releaseCredit: false`,
 * including for a fully synthetic all-positive input.
 */
export const RELEASE_CREDIT_SCHEMA_VERSION = 1 as const;

export const RELEASE_CREDIT_ISSUE_CODES = [
  'RELEASE_SHAPE',
  'RELEASE_SCHEMA',
  'RELEASE_GATE_F',
  'RELEASE_GATE_F_INTEGRITY',
  'RELEASE_MANIFEST',
  'RELEASE_MANIFEST_STATE',
  'RELEASE_MANIFEST_DRIFT',
  'RELEASE_EXECUTION',
  'RELEASE_EXECUTION_MISSING',
  'RELEASE_EXECUTION_DUPLICATE',
  'RELEASE_EXECUTION_EXTRA',
  'RELEASE_EXECUTION_ORDER',
  'RELEASE_EXECUTION_SKIPPED',
  'RELEASE_EXECUTION_RETRIED',
  'RELEASE_EXECUTION_REPLACED',
  'RELEASE_RESULT',
  'RELEASE_EVIDENCE',
  'RELEASE_CLEANUP',
  'RELEASE_DIAGNOSTIC_PASS',
  'RELEASE_CREDIT',
] as const;
export type ReleaseCreditIssueCode = (typeof RELEASE_CREDIT_ISSUE_CODES)[number];

export const RELEASE_GATE_F_INTEGRITY_VALUES = ['complete', 'incomplete', 'invalid'] as const;
export type ReleaseGateFIntegrity = (typeof RELEASE_GATE_F_INTEGRITY_VALUES)[number];

/** Closed local outcome vocabulary; mirrors the engine's terminal outcomes. */
export const RELEASE_OUTCOMES = ['PASS', 'BUG', 'HARNESS_BLOCKED', 'ENVIRONMENT_FAILURE'] as const;
export type ReleaseOutcome = (typeof RELEASE_OUTCOMES)[number];

/**
 * Caller-supplied Gate-F integrity status. The static predicate can check that
 * the status is well formed and self-consistent, but its presence never proves
 * an accepted Gate F and it can never promote credit.
 */
export interface ReleaseGateFStatus {
  readonly accepted: boolean;
  readonly integrity: ReleaseGateFIntegrity;
}

/** Governance-pinned identity of the exact approved-frozen manifest. */
export interface ReleaseExpectedManifest {
  readonly manifestId: string;
  readonly contentFingerprint: string;
}

/** The manifest the run actually executed; only an `ACTIVE` frozen one is admissible. */
export interface ReleaseActiveManifest {
  readonly manifestId: string;
  readonly contentFingerprint: string;
  readonly state: string;
  readonly revision: number;
}

/** One required entry × environment cell obligation in canonical global order. */
export interface ReleaseRequiredEntry {
  readonly entryId: string;
  readonly cellId: string;
  /** Position in the manifest's canonical global execution order. */
  readonly order: number;
}

export interface ReleaseEvidenceReference {
  readonly evidenceId: string;
  readonly digest: string;
  readonly complete: boolean;
  readonly valid: boolean;
}

export interface ReleaseWorkRecord {
  readonly entryId: string;
  readonly cellId: string;
  readonly order: number;
  /** Exactly `1` is admissible; `2` or more means retried work. */
  readonly attempt: number;
  readonly skipped: boolean;
  readonly replaced: boolean;
  readonly outcome: ReleaseOutcome;
  readonly evidence: ReleaseEvidenceReference;
}

export interface ReleaseCleanupRecord {
  readonly succeeded: boolean;
}

export interface ReleaseAssessmentInput {
  readonly schemaVersion: typeof RELEASE_CREDIT_SCHEMA_VERSION;
  readonly gateF: ReleaseGateFStatus | undefined;
  readonly expectedManifest: ReleaseExpectedManifest | undefined;
  readonly activeManifest: ReleaseActiveManifest | undefined;
  readonly requiredEntries: readonly ReleaseRequiredEntry[];
  readonly work: readonly ReleaseWorkRecord[];
  readonly cleanup: ReleaseCleanupRecord | undefined;
  /**
   * A later Diagnostic `PASS` presented to a Release assessment. Diagnostic
   * evidence can never repair an earlier Release result, so its presence always
   * denies eligibility.
   */
  readonly diagnosticPass?: { readonly runId: string } | undefined;
}

export interface ReleaseCreditAssessment {
  /** Static predicate result only; `true` never means credit was granted. */
  readonly eligible: boolean;
  readonly issues: readonly ReleaseCreditIssueCode[];
  /** Always false. No input, including a fully synthetic all-positive one, grants credit. */
  readonly releaseCredit: false;
}
