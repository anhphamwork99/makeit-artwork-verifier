import { isCheckResultStatus } from '../contracts/correctness';
import type { NonPassMeaning, Outcome } from '../contracts/discriminants';

/**
 * Pure status-derived outcome classifier (P7-B B1-A, ADR 0025 §4).
 *
 * This is the inactive final kernel. It derives the behavior outcome from the
 * explicit required-check statuses and authority facts only — never from
 * `harnessInvalid`, diagnostic evidence, or a boolean compatibility surface.
 * The active `runtime/outcomes.ts` classifier remains unchanged and in force
 * until the atomic B2 cutover.
 */

/** Minimal check view: only identity and status carry classification authority. */
export interface StatusCheckView {
  readonly checkId: string;
  readonly status: unknown;
}

export interface StatusOutcomeInput {
  requiredChecks: readonly StatusCheckView[];
  /** Overlapping required sources disagree with interpretable current evidence. */
  requiredSourcesAgree?: boolean;
}

export interface FinalStatusOutcomeInput extends StatusOutcomeInput {
  cleanupSucceeded: boolean;
  /** External allocation/launch/browser/prerequisite failure. */
  externalFailure?: boolean;
}

/**
 * The complete behavior-outcome precedence, highest first. A `FAIL` beside an
 * `UNUSABLE` resolves to `HARNESS_BLOCKED` because incomplete authority cannot
 * support a complete product verdict (ADR 0025 §4 rule 4).
 */
export const STATUS_OUTCOME_PRECEDENCE = [
  'empty-required-checks -> HARNESS_BLOCKED',
  'unknown-or-UNUSABLE-authority -> HARNESS_BLOCKED',
  'trustworthy-FAIL -> BUG',
  'required-source-disagreement -> BUG',
  'all-PASS-and-sources-agree -> PASS',
] as const;

function isUnusable(check: StatusCheckView): boolean {
  // A missing, omitted, or unknown status is unusable authority and fails
  // closed rather than defaulting to PASS or FAIL.
  return !isCheckResultStatus(check.status) || check.status === 'UNUSABLE';
}

/**
 * Behavior outcome from required-check statuses and authority facts. `PASS` is
 * provisional here: final `PASS` additionally requires complete cleanup and
 * successful finalization.
 */
export function classifyBehaviorOutcome(input: StatusOutcomeInput): Outcome {
  if (input.requiredChecks.length === 0) return 'HARNESS_BLOCKED';
  if (input.requiredChecks.some(isUnusable)) return 'HARNESS_BLOCKED';
  if (input.requiredChecks.some((check) => check.status === 'FAIL')) return 'BUG';
  if (input.requiredSourcesAgree === false) return 'BUG';
  return 'PASS';
}

/**
 * Final outcome. External or cleanup failure converts any provisional `PASS`
 * to `ENVIRONMENT_FAILURE`; the behavior outcome remains separately available
 * from `classifyStatusOutcome` so neither fact is erased.
 */
export function classifyFinalOutcome(input: FinalStatusOutcomeInput): Outcome {
  if (input.externalFailure === true) return 'ENVIRONMENT_FAILURE';
  if (!input.cleanupSucceeded) return 'ENVIRONMENT_FAILURE';
  return classifyBehaviorOutcome(input);
}

export interface ClassifiedStatusOutcome {
  /** Null only for a pre-authority external failure with no evaluated checks. */
  behaviorOutcome: Outcome | null;
  finalOutcome: Outcome;
  unusableCheckIds: readonly string[];
  failingCheckIds: readonly string[];
}

/**
 * Classifies both the behavior and final outcome in one pass and reports the
 * exact contributing check ids. The two facts are preserved independently, so
 * a later cleanup/external failure never erases an earlier `BUG` or
 * `HARNESS_BLOCKED` behavior result.
 */
export function classifyStatusOutcome(input: FinalStatusOutcomeInput): ClassifiedStatusOutcome {
  const unusableCheckIds = input.requiredChecks.filter(isUnusable).map((check) => check.checkId);
  const failingCheckIds = input.requiredChecks
    .filter((check) => check.status === 'FAIL')
    .map((check) => check.checkId);
  const behaviorOutcome =
    input.externalFailure === true && input.requiredChecks.length === 0
      ? null
      : classifyBehaviorOutcome(input);
  const finalOutcome =
    input.externalFailure === true || !input.cleanupSucceeded
      ? 'ENVIRONMENT_FAILURE'
      : (behaviorOutcome ?? 'HARNESS_BLOCKED');
  return { behaviorOutcome, finalOutcome, unusableCheckIds, failingCheckIds };
}

/** Classifies one status's non-pass meaning (never converts `UNUSABLE` to `BUG`). */
export function statusNonPassMeaning(outcome: Outcome): NonPassMeaning {
  return outcome === 'BUG' ? 'product-defect' : 'unavailable-evidence';
}

export function statusNonPassIsBlocking(outcome: Outcome): boolean {
  return outcome !== 'PASS';
}
