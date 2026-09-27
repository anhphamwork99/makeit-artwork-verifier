import type { DiagnosticEvidence, OutcomeInput } from '../contracts/execution';
import { OUTCOMES, isOutcome, type NonPassMeaning, type Outcome } from '../contracts/discriminants';

export { OUTCOMES, isOutcome };
export type { Outcome };

/**
 * Outcome classification (decisions 0007 and 0008, specification 11.3).
 *
 * Exactly one of four terminal outcomes is ever produced, and each is derived
 * from authoritative inputs only. Diagnostic evidence depth has no authority: it
 * is structurally absent from the classifier input type, so a deeper diagnostic
 * observation can never satisfy, rescue, skip, or override a required check.
 *
 * The outcome vocabulary itself is declared once in `contracts/discriminants`.
 */

export function classifyOutcome(input: OutcomeInput): Outcome {
  // Uninterpretable harness semantics always win: no product claim is possible
  // when the harness cannot establish what happened.
  if (input.harnessInvalid === true) return 'HARNESS_BLOCKED';

  if (input.environmentInvalid === true) return 'ENVIRONMENT_FAILURE';

  // `PASS` requires at least one required authoritative check. An empty set
  // would otherwise grant a vacuous PASS without any correctness evidence.
  if (input.requiredChecks.length === 0) return 'HARNESS_BLOCKED';

  // Mandatory cleanup failure prevents `PASS` while the behavior result stays
  // available diagnostically.
  if (!input.cleanupSucceeded) return 'ENVIRONMENT_FAILURE';

  // Overlapping required sources must agree; no source rescues another.
  if (input.requiredSourcesAgree === false) return 'BUG';

  return input.requiredChecks.every((check) => check.passed) ? 'PASS' : 'BUG';
}

/**
 * Recomputes the terminal outcome from authoritative inputs only. Diagnostic
 * evidence is accepted for evidence-recording callers and is deliberately
 * ignored by the classification.
 */
export function recomputeAuthoritativeOutcome(
  input: OutcomeInput & { diagnosticEvidence?: readonly DiagnosticEvidence[] },
): Outcome {
  return classifyOutcome({
    requiredChecks: input.requiredChecks,
    cleanupSucceeded: input.cleanupSucceeded,
    requiredSourcesAgree: input.requiredSourcesAgree,
    harnessInvalid: input.harnessInvalid,
    environmentInvalid: input.environmentInvalid,
  });
}

export function nonPassIsBlocking(outcome: Outcome): boolean {
  return outcome !== 'PASS';
}

export function nonPassMeaning(outcome: Outcome): NonPassMeaning {
  return outcome === 'BUG' ? 'product-defect' : 'unavailable-evidence';
}
