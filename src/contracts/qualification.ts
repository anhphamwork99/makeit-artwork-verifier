/**
 * Static Gate-G preparation only: nothing in this module executes a qualification,
 * activates a manifest, or grants Release credit (production specification §13.3).
 *
 * A qualification batch is admission evidence. Its cell/case/order/count
 * assignment is fixed before any result exists, so there is deliberately no
 * append, filter, retry-to-green, or replacement surface here.
 */
export const QUALIFICATION_SCHEMA_VERSION = 1 as const;

/** §13.3: one fixed batch of three independently allocated fresh instances per required cell. */
export const QUALIFICATION_INSTANCES_PER_CELL = 3 as const;

export const QUALIFICATION_ISSUE_CODES = [
  'QUALIFICATION_SHAPE',
  'QUALIFICATION_SCHEMA',
  'QUALIFICATION_CANDIDATE',
  'QUALIFICATION_CELLS',
  'QUALIFICATION_ALLOCATION',
  'QUALIFICATION_BATCH_IDENTITY',
  'QUALIFICATION_RESULTS_SHAPE',
  'QUALIFICATION_MISSING',
  'QUALIFICATION_DUPLICATE',
  'QUALIFICATION_EXTRA',
  'QUALIFICATION_ORDER',
  'QUALIFICATION_RESULT',
  'QUALIFICATION_CREDIT',
] as const;
export type QualificationIssueCode = (typeof QUALIFICATION_ISSUE_CODES)[number];

/** Closed local outcome vocabulary; mirrors the engine's terminal outcomes. */
export const QUALIFICATION_OUTCOMES = [
  'PASS',
  'BUG',
  'HARNESS_BLOCKED',
  'ENVIRONMENT_FAILURE',
] as const;
export type QualificationOutcome = (typeof QUALIFICATION_OUTCOMES)[number];

/** Frozen candidate reference: the manifest identity this batch would qualify. */
export interface QualificationCandidate {
  readonly manifestId: string;
  readonly contentFingerprint: string;
}

/** One independently identified Execution Instance inside a fixed cell. */
export interface QualificationInstance {
  readonly instanceId: string;
  readonly cellId: string;
  /** Zero-based admission order inside the cell; position is significant. */
  readonly order: number;
}

export interface QualificationCell {
  readonly cellId: string;
  /** Exactly three instances, in canonical admission order, fixed before results. */
  readonly instances: readonly QualificationInstance[];
}

export interface QualificationBatch {
  readonly schemaVersion: typeof QUALIFICATION_SCHEMA_VERSION;
  readonly candidateManifestId: string;
  readonly candidateFingerprint: string;
  readonly cells: readonly QualificationCell[];
  readonly batchFingerprint: string;
}

export interface QualificationInstanceResult {
  readonly instanceId: string;
  readonly cellId: string;
  readonly order: number;
  readonly outcome: QualificationOutcome;
}

export interface QualificationBatchCreation {
  readonly valid: boolean;
  /** The frozen batch, or `null` when the candidate/cells are not admissible. */
  readonly batch: QualificationBatch | null;
  readonly issues: readonly QualificationIssueCode[];
  /** Always false: a fixed batch is admission input, never Release credit. */
  readonly releaseCredit: false;
}

export interface QualificationEvaluation {
  /** Static admission assessment only; admission is neither approval nor Release credit. */
  readonly admitted: boolean;
  readonly issues: readonly QualificationIssueCode[];
  /** Always false: even an admitted batch never grants Release credit. */
  readonly releaseCredit: false;
}
