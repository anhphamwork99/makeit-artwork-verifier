/** Static Gate-G preparation only: these records never activate a Release manifest. */
export const MANIFEST_LIFECYCLE_SCHEMA_VERSION = 1 as const;
export const MANIFEST_STATES = [
  'GENERATED_DRAFT',
  'VALIDATED_CANDIDATE',
  'QUALIFYING',
  'REVIEW_READY',
  'APPROVED_FROZEN',
  'ACTIVE',
  'SUPERSEDED',
  'REVOKED',
] as const;
export type ManifestState = (typeof MANIFEST_STATES)[number];

export const MANIFEST_ISSUE_CODES = [
  'MANIFEST_SHAPE',
  'MANIFEST_SCHEMA',
  'MANIFEST_STATE',
  'MANIFEST_REVISION',
  'MANIFEST_REFERENCE',
  'MANIFEST_DUPLICATE',
  'MANIFEST_ORDER',
  'MANIFEST_COVERAGE',
  'MANIFEST_FINGERPRINT',
  'MANIFEST_APPROVAL_REFERENCE',
  'MANIFEST_TRANSITION',
  'MANIFEST_FROZEN_MUTATION',
] as const;
export type ManifestIssueCode = (typeof MANIFEST_ISSUE_CODES)[number];

/** Syntactic reference only. Presence does not authenticate human approval. */
export interface ManifestApprovalReference {
  readonly authority: string;
  readonly reference: string;
  readonly digest: string;
}
export interface ManifestCoverageBinding {
  readonly bindingId: string;
  readonly modelFingerprint: string;
}
export interface ManifestRequiredCell {
  readonly cellId: string;
  readonly classification: 'required-credit';
}
/** Position is significant: entries are the canonical global execution order. */
export interface ManifestEntry {
  readonly entryId: string;
  readonly bindingId: string;
  readonly cellId: string;
  readonly order: number;
}
export interface SelectionManifestContent {
  readonly schemaVersion: typeof MANIFEST_LIFECYCLE_SCHEMA_VERSION;
  readonly bindings: readonly ManifestCoverageBinding[];
  readonly requiredCells: readonly ManifestRequiredCell[];
  readonly entries: readonly ManifestEntry[];
}
export interface SelectionManifest {
  readonly schemaVersion: typeof MANIFEST_LIFECYCLE_SCHEMA_VERSION;
  readonly manifestId: string;
  readonly revision: number;
  readonly state: ManifestState;
  readonly content: SelectionManifestContent;
  readonly contentFingerprint: string;
  readonly approvalReference?: ManifestApprovalReference;
}
export interface ManifestValidation {
  readonly valid: boolean;
  readonly issues: readonly ManifestIssueCode[];
  /** Always false: static structure is never evidence of Release admission. */
  readonly releaseCredit: false;
}

export const MANIFEST_TRANSITIONS: Readonly<Record<ManifestState, readonly ManifestState[]>> = {
  GENERATED_DRAFT: ['VALIDATED_CANDIDATE'],
  VALIDATED_CANDIDATE: ['QUALIFYING'],
  QUALIFYING: ['REVIEW_READY'],
  REVIEW_READY: ['APPROVED_FROZEN'],
  APPROVED_FROZEN: ['ACTIVE'],
  ACTIVE: ['SUPERSEDED', 'REVOKED'],
  SUPERSEDED: [],
  REVOKED: [],
};
