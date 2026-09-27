import type { ExecutableSelectionManifestDraftV1 } from './executable-selection-manifest';
import type { EnvironmentCell } from './runtime';
import type { GovernanceTimingV1 } from './governance-timing';
import {
  BUDGET_POLICY_METHOD,
  BUDGET_POLICY_SCHEMA_VERSION,
  type BudgetFamilyMeasurementV1,
  type BudgetPolicyCeilingsV1,
  type BudgetPolicyFamilyStateV1,
} from './budget-retention';

export const RELEASE_RUNTIME_SCHEMA_VERSION = 1 as const;
export const RELEASE_APPROVAL_ACTOR = 'delegated-owner / Codex orchestrator' as const;

/** Closed governance-ledger record version for new budget-bearing Release records (ADR 0112). */
export const RELEASE_LEDGER_SCHEMA_VERSION_V2 = 2 as const;
/**
 * Budget-method identity bound into a V2 Release predeclaration. Both constants
 * are aliases of the WP4 `full-scope-envelope-v1` method so the ledger and the
 * policy verifier cannot drift into two different method vocabularies.
 */
export const RELEASE_BUDGET_METHOD = BUDGET_POLICY_METHOD;
export const RELEASE_BUDGET_METHOD_VERSION = BUDGET_POLICY_SCHEMA_VERSION;

export interface ReleaseWorkSlotV1 {
  readonly order: number;
  readonly entryId: string;
  readonly cell: EnvironmentCell;
  readonly instanceId: string;
  readonly runId: string;
}

export interface ReleaseReviewReceiptV1 {
  readonly schemaVersion: 1;
  readonly reviewId: string;
  readonly reviewer: string;
  readonly result: 'PASS';
  readonly manifestId: string;
  readonly manifestFingerprint: string;
  readonly qualificationBatchId: string;
  readonly qualificationLedgerDigest: string;
  readonly proposalDigest: string;
  readonly rationale: string;
}

export interface ReleaseScopeProposalV1 {
  readonly schemaVersion: 1;
  readonly state: 'PROPOSED_NOT_APPROVED';
  readonly manifestId: string;
  readonly contentFingerprint: string;
  readonly artifact: string;
  readonly releaseCredit: false;
  readonly scope: string;
  readonly qualificationEntryIdsInOrder: readonly string[];
  readonly qualificationScenarioOrder: readonly string[];
  readonly selectionRationale: string;
  readonly lostObligationsByBinding: readonly {
    readonly subjectId: string;
    readonly capability: string;
    readonly includedEntryIds: readonly string[];
    readonly uncoveredObligations: readonly string[];
  }[];
  readonly exclusionCount: number;
  readonly exclusionReasonCounts: Readonly<Record<string, number>>;
  readonly completeExclusionLedgerSource: string;
}

export interface ReleaseApprovalV1 {
  readonly schemaVersion: 1;
  readonly approvalId: string;
  readonly decisionMaker: typeof RELEASE_APPROVAL_ACTOR;
  readonly mandate: 'ADR-0099';
  readonly decisionScope: 'activate-exact-release-candidate';
  readonly manifestId: string;
  readonly manifestFingerprint: string;
  readonly draftBytesDigest: string;
  readonly qualificationBatchId: string;
  readonly qualificationBatchFingerprint: string;
  readonly qualificationLedgerDigest: string;
  readonly requiredWork: readonly { readonly entryId: string; readonly cellId: string }[];
  readonly proposalReference: string;
  readonly proposalBytesDigest: string;
  readonly qualificationEntryIdsInOrder: readonly string[];
  readonly reviews: readonly { readonly reviewId: string; readonly bytesDigest: string }[];
  readonly rationale: string;
  readonly timestamp: string;
  readonly previousLifecycleDigest: string;
  readonly recordDigest: string;
}

/**
 * Exact inputs a Release preflight binds to the currently governed manifest and
 * Qualification lineage. `policyApprovalId` is only a locator reference: it
 * confers no authority by itself and the independent trust root must still
 * attest it before any policy can be bound.
 */
export interface ReleaseBudgetPreflightInputV1 {
  readonly manifestId: string;
  readonly manifestFingerprint: string;
  readonly requiredCellId: string;
  readonly sourceProvenanceDigest: string;
  readonly policyApprovalId: string | null;
}

/** Exact measurement/retention basis digests the verified policy is bound to. */
export interface ReleaseBudgetMeasurementBasisV1 {
  readonly measurementSetContentDigest: string;
  readonly retentionAuditId: string;
  readonly retentionAuditDigest: string;
}

/**
 * Independently verified, still non-creditable budget preflight. This is *not*
 * policy approval and *not* Release credit: `releaseCredit` is literally
 * `false`. Only an independent trust root can produce one; the default provider
 * always refuses.
 */
export interface VerifiedBudgetPreflightV1 {
  readonly releaseCredit: false;
  readonly policyApprovalId: string;
  /** Raw-byte digest of the exact approved policy proposal artifact. */
  readonly policyDigest: string;
  /** Raw-byte digest of the delegated-owner approval artifact pinning the policy. */
  readonly approvalDigest: string;
  /** Raw-byte digest of the independent review artifact pinning the policy. */
  readonly reviewDigest: string;
  readonly measurementSetId: string;
  readonly measurementSetContentDigest: string;
  readonly method: typeof RELEASE_BUDGET_METHOD;
  readonly methodVersion: typeof RELEASE_BUDGET_METHOD_VERSION;
  readonly ceilings: BudgetPolicyCeilingsV1;
  /** Explicit measurement limitations; must disclose every unsupported family counter. */
  readonly limitations: readonly string[];
  readonly manifestId: string;
  readonly manifestFingerprint: string;
  readonly requiredCellId: string;
  readonly sourceProvenanceDigest: string;
  readonly basis: ReleaseBudgetMeasurementBasisV1;
}

/** Sanitized refusal vocabulary; never a path, exception or private detail. */
export type ReleaseBudgetPreflightFailureCode =
  | 'BUDGET_AUTHORITY_UNATTESTED'
  | 'BUDGET_AUTHORITY_MISMATCH'
  | 'BUDGET_POLICY_INVALID'
  | 'BUDGET_MEASUREMENT_INVALID'
  | 'BUDGET_BINDING_MISMATCH';

export type ReleaseBudgetPreflightResultV1 =
  | { readonly ok: true; readonly value: VerifiedBudgetPreflightV1 }
  | { readonly ok: false; readonly code: ReleaseBudgetPreflightFailureCode };

/** The six widget families a validated manifest route can select (ADR 0106 §2). */
export const RELEASE_BUDGET_FAMILIES = [
  'image',
  'text',
  'object',
  'crossword',
  'history',
  'restore',
] as const;
export type ReleaseBudgetFamilyV1 = (typeof RELEASE_BUDGET_FAMILIES)[number];

/**
 * Strict per-child budget facts the aggregate Release enforcement consumes after
 * one started slot is strictly verified and cleaned up. `evidenceByteCount` is
 * the verified owned run-root byte total (never a provider summary);
 * `imageTornRecaptures` is a strict Image tear sum, present only for the Image
 * family when a persisted counter is derivable. It never carries a fabricated
 * zero for a non-Image family.
 */
export interface ReleaseChildBudgetFactsV1 {
  readonly family: ReleaseBudgetFamilyV1;
  readonly evidenceByteCount: number;
  readonly imageTornRecaptures: number | null;
}

/**
 * A refused strict-fact read is an integrity stop, never a weaker budget skip:
 * the run terminalizes non-creditably without a `BUDGET_TERMINATED` relabel.
 */
export type ReleaseChildBudgetFactsResultV1 =
  | { readonly ok: true; readonly value: ReleaseChildBudgetFactsV1 }
  | { readonly ok: false; readonly code: 'EVIDENCE_INVALID' };

export type ReleaseLifecycleEventV1 =
  | {
      readonly type: 'APPROVED_FROZEN';
      readonly manifest: ExecutableSelectionManifestDraftV1;
      readonly draftBytesDigest: string;
      readonly batchId: string;
      readonly batchFingerprint: string;
      readonly qualificationLedgerDigest: string;
      readonly approvalId: string;
      readonly approvalBytesDigest: string;
      readonly proposalBytesDigest: string;
      readonly reviewBytesDigests: readonly string[];
      readonly work: readonly { readonly entryId: string; readonly cellId: string }[];
    }
  | { readonly type: 'ACTIVE'; readonly frozenEventDigest: string };

export interface ReleaseLedgerRecordV1 {
  readonly schemaVersion: 1;
  readonly ledgerId: string;
  readonly sequence: number;
  readonly previousDigest: string | null;
  readonly event: ReleaseLifecycleEventV1 | ReleaseRunEventV1;
  readonly digest: string;
}

export type ReleaseRunEventV1 =
  | {
      readonly type: 'run-predeclared';
      readonly lifecycleId: string;
      readonly activeEventDigest: string;
      readonly slots: readonly ReleaseWorkSlotV1[];
      readonly shardPlanFingerprint: string;
    }
  | { readonly type: 'run-started'; readonly lifecycleDigest: string }
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
      readonly recordDigest: string | null;
      readonly evidenceDigest: string | null;
      readonly failureCode: string | null;
      /** Absent only in retained pre-WP1 history or a run with an invalid clock. */
      readonly timing?: GovernanceTimingV1;
    }
  | {
      readonly type: 'run-assessed';
      readonly state: 'COMPLETE_ALL_PASS' | 'NON_CREDITABLE' | 'INTERRUPTED';
      readonly unstartedOrders: readonly number[];
      readonly releaseCreditGranted: boolean;
      /** Absent only in retained pre-WP1 history or a run with an invalid clock. */
      readonly timing?: GovernanceTimingV1;
      /** Present when governance elapsed time failed closed; child results remain unchanged. */
      readonly timingFailureCode?: 'TIMING_INVALID';
    };

/**
 * V2 predeclaration. Unlike V1 it is *bound* to the independently verified
 * policy and measurement-set raw-byte digests and method identity, so a budget
 * ceiling/terminal decision can later be reconstructed from the ledger alone.
 */
export interface ReleaseRunPredeclarationV2 {
  readonly type: 'run-predeclared';
  readonly lifecycleId: string;
  readonly activeEventDigest: string;
  readonly slots: readonly ReleaseWorkSlotV1[];
  readonly shardPlanFingerprint: string;
  readonly budget: VerifiedBudgetPreflightV1;
}

/** V2 terminal states add explicit, non-creditable budget termination. */
export type ReleaseRunStateV2 =
  | 'COMPLETE_ALL_PASS'
  | 'NON_CREDITABLE'
  | 'INTERRUPTED'
  | 'BUDGET_TERMINATED';

/**
 * V2 provisional non-credit assessment (ADR 0113 finite metered endpoint). It is
 * durably appended and strictly reread *before* the sole monotonic endpoint
 * sample, so the checked interval includes provisional persistence/readback
 * waiting. It is explicitly `pending`: it is never a final assessment and can
 * never grant credit or establish a durable terminal state.
 */
export interface ReleaseRunProvisionalV2 {
  readonly type: 'run-provisional';
  /** Exact strictly verified ordered prefix whose slots were each started. */
  readonly completedOrders: readonly number[];
  /** Exact immutable remaining ordered suffix; none of these may start. */
  readonly unstartedOrders: readonly number[];
  /** Literal pending marker: a provisional record is never final. */
  readonly pending: true;
  /** Literal non-credit marker. */
  readonly releaseCreditGranted: false;
}

export interface ReleaseRunAssessmentV2 {
  readonly type: 'run-assessed';
  readonly state: ReleaseRunStateV2;
  readonly unstartedOrders: readonly number[];
  /**
   * Derived terminal credit. Only an independently rooted production budget
   * authority that reproduces the bound policy/set raw bytes can set this true;
   * at readback it is consistency data, never authority. A structurally complete
   * run is not automatically creditable (ADR 0111/0112).
   */
  readonly releaseCreditGranted: boolean;
  /** Absent only in a run with an invalid clock. */
  readonly timing?: GovernanceTimingV1;
  /** Present when governance elapsed time failed closed; child results remain unchanged. */
  readonly timingFailureCode?: 'TIMING_INVALID';
}

/**
 * V2 run event union. The shared slot events reuse their V1 shapes verbatim so a
 * V2 ledger cannot silently widen their meaning; only the predeclaration and
 * terminal assessment carry budget-specific fields.
 */
export type ReleaseRunEventV2 =
  | ReleaseRunPredeclarationV2
  | Extract<ReleaseRunEventV1, { readonly type: 'run-started' }>
  | Extract<ReleaseRunEventV1, { readonly type: 'slot-started' }>
  | Extract<ReleaseRunEventV1, { readonly type: 'slot-finished' }>
  | ReleaseRunProvisionalV2
  | ReleaseRunAssessmentV2;

/**
 * Derived authority of a terminal budget classification. `ROOT_BOUND` is only
 * ever produced when the independently rooted production budget authority
 * corroborates the exact bound policy/set raw bytes; any injectable/synthetic
 * seam yields `NON_AUTHORITATIVE` and can never establish an authoritative
 * `BUDGET_TERMINATED`, durable verified terminal or Release credit (ADR 0113).
 * It is derived at readback, never trusted from stored ledger state.
 */
export type ReleaseBudgetAuthorityV1 = 'ROOT_BOUND' | 'NON_AUTHORITATIVE';

/**
 * Independent WP5-C rederivation of a terminal V2 budget state from persisted
 * governance data plus strict child evidence, produced only by the readback
 * reader (`verifyReleaseRun`). Every field is recomputed, never copied from a
 * stored boolean: the elapsed value is the bound endpoint timing, the byte/torn
 * totals are re-read from the rooted child evidence, and the ceiling comparison
 * is made against the bound predeclaration's own ceilings.
 *
 * **Integrity/readback consistency only, not cryptographic external
 * authentication.** The persisted monotonic endpoint value has no independent
 * timing witness or signature, so this proves the stored value is internally
 * consistent with the rederived counters, exact prefix/suffix joins and bound
 * ceilings. It does not prove that a monotonic clock produced the value, and it
 * cannot detect a wholesale re-signed ledger rewrite (ADR 0113 §5).
 */
export interface ReleaseBudgetRederivationV1 {
  /** State independently derived from persisted evidence and bound ceilings. */
  readonly state: ReleaseRunStateV2;
  /** Persisted bound endpoint timing used as the sole aggregate duration. */
  readonly elapsedMs: number;
  readonly durationCeilingMs: number | null;
  /** Sum of strictly re-read owned child evidence bytes for verified slots. */
  readonly evidenceByteCount: number;
  readonly evidenceByteCeiling: number | null;
  /** Sum of strictly re-read applicable Image tear counters. */
  readonly imageTornRecaptures: number;
  readonly imageTornCeiling: number | null;
  /** True when elapsed, bytes or torn counts strictly exceed a bound ceiling. */
  readonly ceilingExceeded: boolean;
  /** Derived credit eligibility, never the persisted flag. */
  readonly credit: boolean;
  /** Derived classification authority, never the persisted flag. */
  readonly budgetAuthority: ReleaseBudgetAuthorityV1;
}

export interface ReleaseLedgerRecordV2 {
  readonly schemaVersion: typeof RELEASE_LEDGER_SCHEMA_VERSION_V2;
  readonly ledgerId: string;
  readonly sequence: number;
  readonly previousDigest: string | null;
  readonly event: ReleaseLifecycleEventV1 | ReleaseRunEventV2;
  readonly digest: string;
}

/** A read ledger chain; every record in one chain shares one schema version. */
export type ReleaseLedgerRecord = ReleaseLedgerRecordV1 | ReleaseLedgerRecordV2;

export type ReleaseRuntimeFailureCode =
  | 'ARGUMENTS_INVALID'
  | 'APPROVAL_INVALID'
  | 'APPROVAL_MISMATCH'
  | 'PROPOSAL_INVALID'
  | 'REVIEW_INVALID'
  | 'QUALIFICATION_INVALID'
  | 'CANDIDATE_INVALID'
  | 'SOURCE_DRIFT'
  | 'LIFECYCLE_INVALID'
  | 'ALREADY_ACTIVE'
  | 'RUN_CONSUMED'
  | 'PLAN_INVALID'
  | 'EXECUTION_INTERRUPTED'
  | 'LEDGER_INVALID'
  | 'BUDGET_PREFLIGHT_REFUSED';

export type ReleaseRuntimeResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: ReleaseRuntimeFailureCode };
