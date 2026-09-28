/**
 * Pure Package-8 transaction-state model (ADR 0041 P8-A1).
 *
 * A run or suite is a two-phase evidence transaction whose sole commit point is
 * an exclusively created, valid final manifest. Before that commit a failure
 * leaves an immutable partial transaction — an intended inventory with no valid
 * final manifest. A root with no Package-8 manifest is `legacy-unverifiable`
 * when a strict current-v4/suite-v2 record is present; it is never repaired,
 * deleted, or credited.
 *
 * Failure classification is closed and adds no fifth terminal outcome:
 * contract/sanitization/reference failures are `HARNESS_BLOCKED`, and valid
 * transactions prevented by external filesystem/resource failures are
 * `ENVIRONMENT_FAILURE`.
 *
 * This module is pure and imports no filesystem/CLI/runtime code.
 */

import type { EvidenceTransactionKind } from '../contracts/evidence-transaction';

export const EVIDENCE_TRANSACTION_STATES = [
  'committed',
  'partial-transaction',
  'legacy-unverifiable',
  'no-transaction',
  'invalid-transaction',
] as const;
export type EvidenceTransactionState = (typeof EVIDENCE_TRANSACTION_STATES)[number];

/** Only the two accepted non-committed failure classes; there is no tenth state. */
export const EVIDENCE_TRANSACTION_FAILURE_CLASSES = [
  'HARNESS_BLOCKED',
  'ENVIRONMENT_FAILURE',
] as const;
export type EvidenceTransactionFailureClass = (typeof EVIDENCE_TRANSACTION_FAILURE_CLASSES)[number];

export const EVIDENCE_TRANSACTION_FAILURE_CODES = [
  'TRANSACTION_INVENTORY_INVALID',
  'TRANSACTION_MANIFEST_INVALID',
  'TRANSACTION_MANIFEST_WITHOUT_INVENTORY',
  'TRANSACTION_REFERENCES_INVALID',
  'TRANSACTION_COMMIT_ORDER_VIOLATION',
] as const;
export type EvidenceTransactionFailureCode = (typeof EVIDENCE_TRANSACTION_FAILURE_CODES)[number];

/** The explicit, immutable historical representation of a root with no manifest. */
export const LEGACY_UNVERIFIABLE_LABEL = 'legacy-unverifiable';

export interface EvidenceTransactionRootFacts {
  readonly intendedInventoryPresent: boolean;
  readonly intendedInventoryValid: boolean;
  readonly finalManifestPresent: boolean;
  readonly finalManifestValid: boolean;
  readonly referencesValid: boolean;
  /** A strict current-v4 run record or suite-v2 aggregate exists in the root. */
  readonly strictRecordPresent: boolean;
  /** An external filesystem/resource failure was observed during finalization. */
  readonly externalFailure: boolean;
}

export interface EvidenceTransactionClassification {
  readonly state: EvidenceTransactionState;
  readonly failureClass: EvidenceTransactionFailureClass | null;
  readonly failureCode: EvidenceTransactionFailureCode | null;
  /** True only for a valid, fully committed transaction. */
  readonly committed: boolean;
  /** Package-8 credit requires a committed transaction; nothing else earns it. */
  readonly creditEligible: boolean;
  /** A preserved partial transaction is immutable and never repaired or deleted. */
  readonly immutablePartial: boolean;
  /** Legacy roots stay diagnostically readable and grant no Gate-F credit. */
  readonly preservedForDiagnosis: boolean;
}

function classification(
  state: EvidenceTransactionState,
  overrides: Partial<EvidenceTransactionClassification> = {},
): EvidenceTransactionClassification {
  return {
    state,
    failureClass: null,
    failureCode: null,
    committed: state === 'committed',
    creditEligible: state === 'committed',
    immutablePartial: state === 'partial-transaction',
    preservedForDiagnosis: true,
    ...overrides,
  };
}

/**
 * Classify one run/suite evidence root from its observed facts. The rules are
 * total and ordered so the same facts always yield the same state.
 */
export function classifyEvidenceTransaction(
  facts: EvidenceTransactionRootFacts,
): EvidenceTransactionClassification {
  if (!facts.intendedInventoryPresent && !facts.finalManifestPresent) {
    return facts.strictRecordPresent
      ? classification('legacy-unverifiable', { creditEligible: false })
      : classification('no-transaction', { creditEligible: false });
  }

  if (!facts.intendedInventoryPresent && facts.finalManifestPresent) {
    return classification('invalid-transaction', {
      failureClass: 'HARNESS_BLOCKED',
      failureCode: 'TRANSACTION_MANIFEST_WITHOUT_INVENTORY',
    });
  }

  if (facts.intendedInventoryPresent && !facts.finalManifestPresent) {
    if (!facts.intendedInventoryValid) {
      return classification('invalid-transaction', {
        failureClass: 'HARNESS_BLOCKED',
        failureCode: 'TRANSACTION_INVENTORY_INVALID',
      });
    }
    return classification('partial-transaction', {
      failureClass: facts.externalFailure ? 'ENVIRONMENT_FAILURE' : null,
      failureCode: null,
      creditEligible: false,
      immutablePartial: true,
    });
  }

  if (!facts.intendedInventoryValid) {
    return classification('invalid-transaction', {
      failureClass: 'HARNESS_BLOCKED',
      failureCode: 'TRANSACTION_INVENTORY_INVALID',
    });
  }
  if (!facts.finalManifestValid) {
    return classification('invalid-transaction', {
      failureClass: 'HARNESS_BLOCKED',
      failureCode: 'TRANSACTION_MANIFEST_INVALID',
    });
  }
  if (!facts.referencesValid) {
    return classification('invalid-transaction', {
      failureClass: 'HARNESS_BLOCKED',
      failureCode: 'TRANSACTION_REFERENCES_INVALID',
    });
  }
  return classification('committed');
}

export interface LegacyUnverifiableRepresentation {
  readonly label: typeof LEGACY_UNVERIFIABLE_LABEL;
  readonly immutable: true;
  readonly creditEligible: false;
  readonly package8ManifestPresent: false;
  readonly detail: string;
}

/**
 * The explicit `legacy-unverifiable` representation for a root with a strict
 * correctness record but no Package-8 manifest. It neither rewrites historical
 * outcomes nor grants Gate-F credit.
 */
export function describeLegacyUnverifiable(
  transactionKind: EvidenceTransactionKind,
): LegacyUnverifiableRepresentation {
  return {
    label: LEGACY_UNVERIFIABLE_LABEL,
    immutable: true,
    creditEligible: false,
    package8ManifestPresent: false,
    detail: `A ${transactionKind} root without a Package-8 final manifest stays immutable historical evidence.`,
  };
}

// ── Commit-last finalization ──────────────────────────────────────────────────

export const EVIDENCE_FINALIZATION_STEP_KINDS = [
  'intended-inventory',
  'artifact',
  'final-manifest',
] as const;
export type EvidenceFinalizationStepKind = (typeof EVIDENCE_FINALIZATION_STEP_KINDS)[number];

export interface EvidenceFinalizationStep {
  readonly kind: EvidenceFinalizationStepKind;
  readonly relativePath: string;
}

export class EvidenceTransactionPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EvidenceTransactionPlanError';
  }
}

/**
 * Order a publication plan so the final manifest is the last and only commit
 * point. Throws if there is not exactly one final-manifest step or if a
 * final-manifest step is not already last.
 */
export function planFinalizationOrder(
  steps: readonly EvidenceFinalizationStep[],
): readonly EvidenceFinalizationStep[] {
  const inventorySteps = steps.filter((step) => step.kind === 'intended-inventory');
  if (inventorySteps.length !== 1 || steps[0]?.kind !== 'intended-inventory') {
    throw new EvidenceTransactionPlanError(
      'A transaction starts with exactly one intended-inventory document.',
    );
  }
  const manifestSteps = steps.filter((step) => step.kind === 'final-manifest');
  if (manifestSteps.length !== 1) {
    throw new EvidenceTransactionPlanError(
      'A transaction has exactly one final-manifest commit point.',
    );
  }
  const last = steps[steps.length - 1];
  if (last === undefined || last.kind !== 'final-manifest') {
    throw new EvidenceTransactionPlanError('The final manifest must be the last publication step.');
  }
  return [...steps];
}

export function isCommitLastSequence(steps: readonly EvidenceFinalizationStep[]): boolean {
  try {
    planFinalizationOrder(steps);
    return true;
  } catch {
    return false;
  }
}

export interface EvidenceFinalizationOutcome extends EvidenceFinalizationStep {
  readonly result: 'ok' | 'failed';
  readonly failureClass?: EvidenceTransactionFailureClass;
}

export interface EvidenceFinalizationEvaluation {
  readonly commitPointReached: boolean;
  readonly failedStepIndex: number | null;
  readonly failureClass: EvidenceTransactionFailureClass | null;
  readonly failureCode: EvidenceTransactionFailureCode | null;
}

/**
 * Evaluate one ordered finalization attempt. A commit is reached only when the
 * final-manifest step is last, every earlier step succeeded, and the manifest
 * write itself succeeded. An earlier failure means the manifest is never
 * created, so the root stays an immutable partial transaction.
 */
export function evaluateFinalizationOutcomes(
  outcomes: readonly EvidenceFinalizationOutcome[],
): EvidenceFinalizationEvaluation {
  const failedIndex = outcomes.findIndex((outcome) => outcome.result === 'failed');
  const last = outcomes[outcomes.length - 1];
  const manifestLast = last !== undefined && last.kind === 'final-manifest';
  const manifestCount = outcomes.filter((outcome) => outcome.kind === 'final-manifest').length;
  const commitPointReached = failedIndex === -1 && manifestLast && manifestCount === 1;

  if (commitPointReached) {
    return {
      commitPointReached: true,
      failedStepIndex: null,
      failureClass: null,
      failureCode: null,
    };
  }
  if (failedIndex >= 0) {
    const failed = outcomes[failedIndex];
    return {
      commitPointReached: false,
      failedStepIndex: failedIndex,
      failureClass: failed?.failureClass ?? 'HARNESS_BLOCKED',
      failureCode: null,
    };
  }
  return {
    commitPointReached: false,
    failedStepIndex: null,
    failureClass: 'HARNESS_BLOCKED',
    failureCode: 'TRANSACTION_COMMIT_ORDER_VIOLATION',
  };
}
