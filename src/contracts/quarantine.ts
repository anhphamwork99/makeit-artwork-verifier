/**
 * Static Gate-G preparation only: a structurally valid quarantine, replacement,
 * or reinstatement proposal is never an actual quarantine, admitted replacement,
 * reinstatement, human approval, or Release credit (production specification
 * §13.5, §13.8, §13.10).
 *
 * Every public value is readonly. `proposalId` is an externally supplied
 * untrusted reference: only its local string shape is checked, and it is never
 * generated, authenticated, certified unique across records, or treated as
 * content-integrity evidence. This module performs no identity derivation,
 * history/manifest mutation, execution, approval authentication, or credit
 * granting, and it declares no durable governance lifecycle.
 */
export const QUARANTINE_SCHEMA_VERSION = 1 as const;

/** Accepted toolkit terminal outcome vocabulary; never a local fifth outcome. */
export const QUARANTINE_OUTCOMES = [
  'PASS',
  'BUG',
  'HARNESS_BLOCKED',
  'ENVIRONMENT_FAILURE',
] as const;
export type QuarantineOutcome = (typeof QUARANTINE_OUTCOMES)[number];

/**
 * Closed local diagnostic vocabulary. Codes are reported stable, sorted, and
 * deduplicated. `QUARANTINE_IDENTITY` denotes only a malformed `proposalId`
 * reference shape; it never means a derived, authenticated, or unique identity.
 */
export const QUARANTINE_ISSUE_CODES = [
  'QUARANTINE_SHAPE',
  'QUARANTINE_SCHEMA',
  'QUARANTINE_IDENTITY',
  'QUARANTINE_MANIFEST',
  'QUARANTINE_FINGERPRINT',
  'QUARANTINE_OBLIGATION',
  'QUARANTINE_INSTABILITY',
  'QUARANTINE_EVIDENCE',
  'QUARANTINE_TIMING',
  'QUARANTINE_MAPPING',
  'QUARANTINE_QUALIFICATION',
  'QUARANTINE_APPROVAL',
  'QUARANTINE_SCOPE',
  'QUARANTINE_MUTATION',
  'QUARANTINE_PROMOTION',
  'QUARANTINE_CREDIT',
] as const;
export type QuarantineIssueCode = (typeof QUARANTINE_ISSUE_CODES)[number];

/** Proposal decisions. A proposal is never an applied governance action. */
export const QUARANTINE_DECISIONS = ['QUARANTINE_PROPOSED', 'QUARANTINE_REJECTED'] as const;
export type QuarantineDecision = (typeof QUARANTINE_DECISIONS)[number];

export const REPLACEMENT_DECISIONS = ['REPLACEMENT_PROPOSED', 'REPLACEMENT_REJECTED'] as const;
export type ReplacementDecision = (typeof REPLACEMENT_DECISIONS)[number];

export const REINSTATEMENT_DECISIONS = [
  'REINSTATEMENT_PROPOSED',
  'REINSTATEMENT_REJECTED',
] as const;
export type ReinstatementDecision = (typeof REINSTATEMENT_DECISIONS)[number];

/**
 * §13.10: the single action-scoped final-approval authority for quarantine
 * replacement, reinstatement, and scope narrowing (the Product Owner gives
 * final approval for scope, exact fingerprints/digests, and claim wording).
 *
 * This is deliberately *not* a universal four-role matrix: no verification,
 * developer, or designer role is fabricated as mandatory here, and a supplied
 * reference is never authenticated or treated as a human decision.
 */
export const QUARANTINE_FINAL_APPROVAL_AUTHORITY = 'PRODUCT_OWNER' as const;

/** A governance-pinned manifest identity (reference shape only). */
export interface QuarantineManifestReference {
  readonly manifestId: string;
  readonly contentFingerprint: string;
}

/** One Coverage Obligation: its id plus the manifest/fingerprint that owns it. */
export interface ObligationRef {
  readonly obligationId: string;
  readonly manifestId: string;
  readonly contentFingerprint: string;
}

/** A caller-supplied evidence reference; `complete`/`valid` are untrusted claims. */
export interface QuarantineEvidenceReference {
  readonly evidenceId: string;
  readonly digest: string;
  readonly complete: boolean;
  readonly valid: boolean;
}

/**
 * One comparable instability observation for a single obligation/fingerprint
 * pair. Two of these for the same obligation with distinct execution instances
 * and contradictory outcomes are the quarantine trigger; shape never proves the
 * observations are true.
 */
export interface InstabilityEvidenceReference {
  readonly evidenceId: string;
  readonly executionInstanceId: string;
  readonly digest: string;
  readonly outcome: QuarantineOutcome;
  readonly obligation: ObligationRef;
}

/** A caller-supplied external approval reference; shape is never authentication. */
export interface QuarantineApprovalReference {
  readonly authority: string;
  readonly reference: string;
  readonly digest: string;
}

/** Shape-only qualification/admission reference for a fixed batch. */
export interface QuarantineQualificationReference {
  readonly batchId: string;
  readonly manifestId: string;
  readonly contentFingerprint: string;
  /** Untrusted claim; only `true` passes shape and is still never admission proof. */
  readonly admitted: boolean;
}

/**
 * Effect claims a proposal may assert. Every asserted effect is unrepresentable
 * here by design: the assessment records the attempt and fails closed instead of
 * applying it, and never narrows, discharges, mutates, or credits anything.
 */
export interface QuarantineAssertedEffects {
  readonly mutatesHistory?: boolean;
  readonly mutatesManifest?: boolean;
  readonly narrowsScope?: boolean;
  readonly clearsObligations?: readonly string[];
  readonly diagnosticPass?: { readonly runId: string };
  readonly grantsReleaseCredit?: boolean;
}

/** One explicit lost→replacement link, both endpoints full references. */
export interface ReplacementMappingPair {
  readonly lostObligation: ObligationRef;
  readonly replacementObligation: ObligationRef;
}

export interface QuarantineProposalInput {
  readonly schemaVersion: typeof QUARANTINE_SCHEMA_VERSION;
  readonly proposalId: string;
  readonly manifest: QuarantineManifestReference;
  /** Supplied manifest fingerprint reference; must agree with `manifest`. */
  readonly fingerprint: string;
  readonly affectedObligation: ObligationRef;
  /** Exactly two comparable instability observations; shape only. */
  readonly evidence: readonly InstabilityEvidenceReference[];
  readonly proposedAtUtc: string;
  readonly assertedEffects?: QuarantineAssertedEffects | undefined;
}

export interface ReplacementProposalInput {
  readonly schemaVersion: typeof QUARANTINE_SCHEMA_VERSION;
  readonly proposalId: string;
  readonly quarantineReference: string;
  readonly lostObligations: readonly ObligationRef[];
  readonly replacementManifest: QuarantineManifestReference;
  /** Shape-only external qualification/admission reference; untrusted claim. */
  readonly qualification: QuarantineQualificationReference | undefined;
  readonly mapping: readonly ReplacementMappingPair[];
  readonly approvals: readonly QuarantineApprovalReference[] | undefined;
  readonly assertedEffects?: QuarantineAssertedEffects | undefined;
}

/** A later Release Run reference; outcome/complete/manifest are untrusted claims. */
export interface QuarantineReleaseRunReference {
  readonly runId: string;
  readonly executedAtUtc: string;
  readonly outcome: QuarantineOutcome;
  readonly complete: boolean;
  readonly manifest: QuarantineManifestReference;
}

export interface ReinstatementProposalInput {
  readonly schemaVersion: typeof QUARANTINE_SCHEMA_VERSION;
  readonly proposalId: string;
  readonly quarantineReference: string;
  readonly affectedObligation: ObligationRef;
  readonly cause: string;
  readonly correction: string;
  readonly nonWeakeningProof: readonly QuarantineEvidenceReference[];
  /** Fixed *new* qualification-batch reference; shape only. */
  readonly qualification: QuarantineQualificationReference | undefined;
  /** New manifest identity; must differ from the quarantined fingerprint. */
  readonly manifest: QuarantineManifestReference | undefined;
  /** Later complete all-PASS Release Run reference; shape only. */
  readonly releaseRun: QuarantineReleaseRunReference | undefined;
  readonly approvals: readonly QuarantineApprovalReference[] | undefined;
  readonly proposedAtUtc: string;
  readonly assertedEffects?: QuarantineAssertedEffects | undefined;
}

export interface QuarantineAssessment {
  readonly schemaVersion: typeof QUARANTINE_SCHEMA_VERSION;
  readonly decision: QuarantineDecision;
  /** Structural/static shape and consistency only; never truth or authority. */
  readonly valid: boolean;
  readonly issues: readonly QuarantineIssueCode[];
  /** Every known affected obligation stays unresolved; nothing is discharged. */
  readonly unresolvedObligations: readonly ObligationRef[];
  /** Always false: a positive-shaped proposal never grants Release credit. */
  readonly releaseCredit: false;
}

export interface ReplacementAssessment {
  readonly schemaVersion: typeof QUARANTINE_SCHEMA_VERSION;
  readonly decision: ReplacementDecision;
  readonly valid: boolean;
  readonly issues: readonly QuarantineIssueCode[];
  /** Every declared lost obligation stays unresolved; mapping transfers nothing. */
  readonly unresolvedObligations: readonly ObligationRef[];
  readonly releaseCredit: false;
}

export interface ReinstatementAssessment {
  readonly schemaVersion: typeof QUARANTINE_SCHEMA_VERSION;
  readonly decision: ReinstatementDecision;
  readonly valid: boolean;
  readonly issues: readonly QuarantineIssueCode[];
  /** The affected obligation stays unresolved; reinstatement is never applied. */
  readonly unresolvedObligations: readonly ObligationRef[];
  readonly releaseCredit: false;
}
