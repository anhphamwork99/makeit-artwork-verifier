/**
 * Static Gate-G preparation only: a structurally complete Production Claim is
 * never authenticated, rendered, published, or credited (production
 * specification §§13.9–13.10 and Gate G).
 *
 * This module declares the claim-completeness *input* vocabulary and its
 * assessment result. It deliberately contains no renderer, publisher,
 * approval-authenticator, or credit-granting surface, and every assessment
 * returns `approvalAuthenticated: false`, `rendered: false`,
 * `published: false`, and `releaseCredit: false` — including for a wholly
 * synthetic all-positive hypothetical input. Structural completeness is
 * presence/shape evidence only; it never means the claim is true, approved,
 * rendered, publishable, or creditable.
 */
export const PRODUCTION_CLAIM_SCHEMA_VERSION = 1 as const;

export const PRODUCTION_CLAIM_ISSUE_CODES = [
  'CLAIM_SHAPE',
  'CLAIM_SCHEMA',
  'CLAIM_SCOPE',
  'CLAIM_BINDING',
  'CLAIM_BINDING_DUPLICATE',
  'CLAIM_COVERAGE',
  'CLAIM_FINGERPRINT',
  'CLAIM_MANIFEST',
  'CLAIM_ENVIRONMENT',
  'CLAIM_RUN_REFERENCE',
  'CLAIM_EXCLUSIONS',
  'CLAIM_APPROVAL_REFERENCE',
] as const;
export type ProductionClaimIssueCode = (typeof PRODUCTION_CLAIM_ISSUE_CODES)[number];

/** Closed held/stale reporting vocabulary for a claim (§13.9). */
export const CLAIM_STATUSES = ['current', 'held', 'stale'] as const;
export type ClaimStatus = (typeof CLAIM_STATUSES)[number];

/**
 * §13.9: the claim's explicit frontend-only scope. `frontendOnly` must be
 * exactly `true`, so no claim can imply backend, mobile, or platform coverage.
 */
export interface ClaimScope {
  readonly frontendOnly: boolean;
  readonly bindings: readonly ClaimBinding[];
}

/**
 * §13.9: one exact Subject × Capability binding, carrying its Coverage Model
 * and correctness-policy fingerprints as supplied by the caller.
 */
export interface ClaimBinding {
  readonly subjectId: string;
  readonly capability: string;
  readonly coverageModelFingerprint: string;
  readonly correctnessPolicyFingerprint: string;
}

/**
 * §13.9: covered scenarios, variants, partitions, transitions, and Coverage
 * Obligations. Every dimension must be declared; a wholly empty declaration is
 * not a claim.
 */
export interface ClaimCoverage {
  readonly scenarios: readonly string[];
  readonly variants: readonly string[];
  readonly partitions: readonly string[];
  readonly transitions: readonly string[];
  readonly obligations: readonly string[];
}

/** §13.9: the exact Selection Manifest identity the claim references. */
export interface ClaimManifestReference {
  readonly manifestId: string;
  readonly contentFingerprint: string;
}

/**
 * §13.9: one environment cell a claim covers. A claim is limited to
 * `required-credit` cells, so any other classification is rejected here;
 * whether the cell was actually completed by the referenced Release Run is
 * content adjudication that this static predicate deliberately does not make.
 */
export interface ClaimEnvironmentCell {
  readonly cellId: string;
  readonly classification: 'required-credit';
  readonly browser: string;
  readonly operatingSystem: string;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  readonly devicePixelRatio: number;
  readonly locale: string;
  readonly timezone: string;
}

export interface ClaimEnvironment {
  readonly cells: readonly ClaimEnvironmentCell[];
}

/** §13.9: the Release Run id and its execution time. */
export interface ClaimRunReference {
  readonly runId: string;
  /** UTC instant of the referenced run, `YYYY-MM-DDTHH:MM:SS[.fff]Z`. */
  readonly executedAtUtc: string;
}

/**
 * §13.9: explicit exclusions, known gaps, and held/stale status. The lists may
 * be empty but must be declared explicitly; the status is reported, never
 * adjudicated and never credit-bearing.
 */
export interface ClaimExclusions {
  readonly exclusions: readonly string[];
  readonly knownGaps: readonly string[];
  readonly status: ClaimStatus;
}

/**
 * A caller-supplied external approval reference (§13.10). A well-formed shape
 * is not authentication: no pure function can verify a human decision, so this
 * reference never approves, renders, publishes, or credits anything.
 */
export interface ClaimApprovalReference {
  readonly role: string;
  readonly authority: string;
  readonly reference: string;
  readonly digest: string;
}

/**
 * Versioned claim-completeness input. Each required dimension is explicitly
 * `undefined`-able so a missing dimension is reported with its own stable
 * issue code rather than being hidden by an absent key.
 */
export interface ProductionClaimInput {
  readonly schemaVersion: typeof PRODUCTION_CLAIM_SCHEMA_VERSION;
  readonly scope: ClaimScope | undefined;
  readonly coverage: ClaimCoverage | undefined;
  readonly manifest: ClaimManifestReference | undefined;
  readonly environment: ClaimEnvironment | undefined;
  readonly run: ClaimRunReference | undefined;
  readonly exclusions: ClaimExclusions | undefined;
  readonly approvals: readonly ClaimApprovalReference[] | undefined;
}

export interface ProductionClaimAssessment {
  /**
   * Structural completeness only: every required dimension is present and well
   * formed. It never means the claim is approved, truthful, or eligible.
   */
  readonly structurallyComplete: boolean;
  readonly issues: readonly ProductionClaimIssueCode[];
  /** Always false: a well-formed reference is never authenticated approval. */
  readonly approvalAuthenticated: false;
  /** Always false: this static preparation contains no claim renderer. */
  readonly rendered: false;
  /** Always false: a pure predicate never publishes a claim. */
  readonly published: false;
  /** Always false: structural completeness grants no Release credit. */
  readonly releaseCredit: false;
}
