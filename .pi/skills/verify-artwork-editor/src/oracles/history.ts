/**
 * Private/deprecated legacy composite check mirror (ADR 0032 §E3-S1). It is
 * retained only so this Oracle module compiles until the E3-S2 architecture
 * switch consumes the additive `primitiveFacts` below. It is deliberately
 * declared locally (never imported from `contracts/execution`) so the Oracle no
 * longer reaches the legacy boolean result authority, and it is never the source
 * of a final status.
 *
 * @deprecated E3-S2 removes the legacy composite authority entirely.
 */
interface LegacyCompositeCheck {
  readonly checkId: string;
  readonly passed: boolean;
}
import { createDiagnostic, type DiagnosticRecord } from '../contracts/diagnostics';
import {
  HISTORY_ACTION_STEPS,
  HISTORY_REQUIRED_CHECKS,
  HISTORY_SETUP_CHECKPOINTS,
  historyTupleEquals,
  historyTupleWithCleanEquals,
  productBaselineClean,
} from '../contracts/history-observation';
import { ORACLE_PROFILE_SCHEMA_VERSION } from '../contracts/schema-versions';

/**
 * Cross-subject history Oracle (ADR 0019 R4; design §6.3).
 *
 * The Oracle consumes only the accepted per-step facts the history drive
 * captured. It is pure: it evaluates the two binding required checks
 * (`history.depth`, `history.meaning`) and never decides product `BUG` versus
 * harness block — that classification belongs to the drive, which knows whether
 * each transition was safely dispatched. A check that cannot be evaluated
 * because the accepted evidence is incomplete is reported as harness-invalid,
 * never silently passed.
 */

export const HISTORY_ORACLE_PROFILE_ID = 'history-cross-subject-v1';
export const HISTORY_ORACLE_PROFILE_VERSION = 1;

export interface HistoryTupleView {
  pastDepth: number;
  futureDepth: number;
  baselineClean: boolean;
}

export interface HistorySetupFact {
  checkpointId: string;
  role: string;
  meaning: string;
  pastDepth: number;
  futureDepth: number;
  baselineClean: boolean;
  meaningFingerprint: string;
}

export interface HistoryActionFact {
  stepIndex: number;
  stepId: string;
  control: 'undo' | 'redo';
  controlAccessibleName: string;
  controlTitle: string;
  controlNativeTag: string;
  controlButtonType: string | null;
  controlVisible: boolean;
  controlEnabledBeforeDispatch: boolean;
  dispatchCount: number;
  preActionRevision: number;
  postActionRevision: number;
  historyBefore: HistoryTupleView;
  historyAfter: HistoryTupleView;
  expectedHistory: HistoryTupleView;
  historyTupleExact: boolean;
  expectedMeaning: string;
  meaningFingerprint: string | null;
  expectedMeaningFingerprint: string | null;
  meaningStructurallyEqual: boolean;
  observationId: string | null;
  idle: { stableFrames: number; waitedMs: number; observationRevision: number } | null;
  tornRecaptureCount: number;
  /** True when a real transition after the armed revision was observed. */
  transitionObserved: boolean;
}

export interface HistoryEvidenceFacts {
  retainedLayoutId: string;
  setup: readonly HistorySetupFact[];
  actions: readonly HistoryActionFact[];
  finalHistory: HistoryTupleView;
}

/**
 * Closed explicit authority vocabulary for the additive primitive observations
 * (ADR 0029 §4 B2-B). `current` means the accepted whole-document chain was
 * readable and internally consistent; `malformed` means the Oracle could not
 * read it. This is the only authority a B2-B5 adapter may read; the legacy
 * aggregate harness-validity flag is deliberately not part of this view.
 */
export const HISTORY_PRIMITIVE_AUTHORITIES = ['current', 'malformed'] as const;
export type HistoryPrimitiveAuthority = (typeof HISTORY_PRIMITIVE_AUTHORITIES)[number];

/** One raw accepted `H0`…`H3` setup checkpoint primitive. */
export interface HistoryPrimitiveSetupFact {
  readonly checkpointId: string;
  readonly role: string;
  readonly meaning: string;
  readonly pastDepth: number;
  readonly futureDepth: number;
  readonly baselineClean: boolean;
  readonly meaningFingerprint: string;
}

/**
 * One raw ordered transition primitive with its native control identity, armed
 * and post-action revisions, Action Cycle epoch binding, post-transition idle
 * observation, torn-recapture count, pre-action/post-action tuples, and the
 * delivered meaning facts. `order` is the accepted chain position; no field is
 * a legacy composite check result.
 */
export interface HistoryPrimitiveTransitionFact {
  readonly order: number;
  readonly stepIndex: number;
  readonly stepId: string;
  readonly control: HistoryActionFact['control'];
  readonly controlAccessibleName: string;
  readonly controlTitle: string;
  readonly controlNativeTag: string;
  readonly controlButtonType: string | null;
  readonly controlVisible: boolean;
  readonly controlEnabledBeforeDispatch: boolean;
  readonly dispatchCount: number;
  /** The delivered Action Cycle epoch identity bound to the armed revision. */
  readonly actionEpochId: string | null;
  readonly observationId: string | null;
  readonly preActionRevision: number;
  readonly postActionRevision: number;
  readonly revisionAdvanced: boolean;
  readonly idle: HistoryActionFact['idle'];
  readonly historyBefore: HistoryTupleView;
  readonly historyAfter: HistoryTupleView;
  readonly expectedHistory: HistoryTupleView;
  readonly historyTupleExact: boolean;
  readonly expectedMeaning: string;
  readonly meaningFingerprint: string | null;
  readonly expectedMeaningFingerprint: string | null;
  readonly meaningStructurallyEqual: boolean;
  readonly transitionObserved: boolean;
  readonly tornRecaptureCount: number;
}

/** One explicit per-check predicate derived from the raw chain. */
export interface HistoryPrimitiveCheckFact {
  readonly checkId: string;
  readonly predicateMet: boolean;
}

/**
 * Additive, explicitly named primitive cross-subject History facts (ADR 0029
 * §4 B2-B). They expose an explicit structured authority, the retained
 * whole-document target, the raw `H0`…`H3` setup checkpoints, the raw ordered
 * six-transition chain with native control/revision/epoch/idle/torn/pre-action
 * facts, the final tuple, the raw pre-action chain-correlation primitive, and
 * one explicit predicate per accepted required check. No field here is a legacy
 * composite boolean check result or the aggregate harness-validity flag.
 */
export interface HistoryPrimitiveFacts {
  readonly authority: HistoryPrimitiveAuthority;
  /** The retained whole-document Layout identity the chain acted on. */
  readonly retainedLayoutId: string | null;
  /** The raw `H0`…`H3` setup checkpoints, or `null` when nothing is readable. */
  readonly setup: readonly HistoryPrimitiveSetupFact[] | null;
  /** The raw ordered transition chain, or `null` when nothing is readable. */
  readonly transitions: readonly HistoryPrimitiveTransitionFact[] | null;
  readonly finalHistory: HistoryTupleView | null;
  /** Whether every pre-action tuple correlates exactly with the previous accepted post-action tuple from the exact `H3`. */
  readonly preActionChainCorrelates: boolean;
  readonly checks: readonly HistoryPrimitiveCheckFact[];
}

/** The explicit primitive facts of a malformed evaluation: nothing readable. */
function malformedHistoryPrimitiveFacts(requiredChecks: readonly string[]): HistoryPrimitiveFacts {
  return {
    authority: 'malformed',
    retainedLayoutId: null,
    setup: null,
    transitions: null,
    finalHistory: null,
    preActionChainCorrelates: false,
    checks: requiredChecks.map((checkId) => ({ checkId, predicateMet: false })),
  };
}

export interface HistoryOracleEvaluation {
  checks: readonly LegacyCompositeCheck[];
  /** True only when both required history checks passed. */
  passed: boolean;
  harnessInvalid: boolean;
  diagnostics: readonly DiagnosticRecord[];
  /**
   * Additive primitive facts for the inactive B2-B5 live-fact adapter. The
   * legacy `checks`/`passed`/`harnessInvalid` fields above remain for the
   * active runtime until the B2-E cutover; the adapter reads only this view.
   */
  primitiveFacts: HistoryPrimitiveFacts;
}

function setupShapeValid(facts: HistoryEvidenceFacts): string | null {
  if (facts.setup.length !== HISTORY_SETUP_CHECKPOINTS.length) {
    return `Setup history declares ${facts.setup.length} checkpoints, not the exact ${HISTORY_SETUP_CHECKPOINTS.length}.`;
  }
  for (const expected of HISTORY_SETUP_CHECKPOINTS) {
    const actual = facts.setup.find((entry) => entry.checkpointId === expected.checkpointId);
    if (actual === undefined) {
      return `Setup history is missing checkpoint ${expected.checkpointId}.`;
    }
    if (actual.pastDepth !== expected.pastDepth || actual.futureDepth !== expected.futureDepth) {
      return `Setup checkpoint ${expected.checkpointId} is not the exact ${expected.pastDepth}/${expected.futureDepth} tuple.`;
    }
    // `baselineClean` is the product's positional fact (`past === 0 && future === 0`),
    // so only the sealed H0 checkpoint is clean; the created states are not.
    const expectedClean = expected.pastDepth === 0 && expected.futureDepth === 0;
    if (actual.baselineClean !== expectedClean) {
      return `Setup checkpoint ${expected.checkpointId} has baselineClean=${String(actual.baselineClean)}, not the product-exact ${String(expectedClean)}.`;
    }
    if (actual.meaning !== expected.meaning) {
      return `Setup checkpoint ${expected.checkpointId} does not carry meaning ${expected.meaning}.`;
    }
  }
  return null;
}

/**
 * Evaluates the two closed history checks. `harnessInvalid` is set only when the
 * accepted evidence cannot support a trustworthy decision (missing/duplicated
 * steps or a malformed setup shape); a well-formed but wrong depth/meaning is a
 * check failure, which the drive classifies as a product `BUG`.
 */
export function evaluateHistoryOracle(
  facts: HistoryEvidenceFacts,
  requiredChecks: readonly string[] = HISTORY_REQUIRED_CHECKS,
): HistoryOracleEvaluation {
  const diagnostics: DiagnosticRecord[] = [];
  const setupProblem = setupShapeValid(facts);
  const stepsExact = facts.actions.length === HISTORY_ACTION_STEPS.length;
  if (setupProblem !== null) {
    diagnostics.push(createDiagnostic('HISTORY_MEANING_MISMATCH', setupProblem));
  }
  if (!stepsExact) {
    diagnostics.push(
      createDiagnostic(
        'HISTORY_TRANSITION_MISSING',
        `History drive recorded ${facts.actions.length} action steps, not the exact ${HISTORY_ACTION_STEPS.length}.`,
      ),
    );
  }
  const harnessInvalid = setupProblem !== null || !stepsExact;

  const depthSatisfied =
    !harnessInvalid &&
    facts.actions.every((action) => {
      // F1: the expected and observed `baselineClean` must be the product-exact
      // positional fact, and the two full tuples must match on it, not only on
      // depth. A hardcoded or contradictory `baselineClean` fails the check.
      const expectedCleanExact =
        action.expectedHistory.baselineClean ===
        productBaselineClean(action.expectedHistory.pastDepth, action.expectedHistory.futureDepth);
      const observedCleanExact =
        action.historyAfter.baselineClean ===
        productBaselineClean(action.historyAfter.pastDepth, action.historyAfter.futureDepth);
      const beforeCleanExact =
        action.historyBefore.baselineClean ===
        productBaselineClean(action.historyBefore.pastDepth, action.historyBefore.futureDepth);
      return (
        action.transitionObserved &&
        action.dispatchCount === 1 &&
        action.postActionRevision > action.preActionRevision &&
        action.historyTupleExact &&
        expectedCleanExact &&
        observedCleanExact &&
        beforeCleanExact &&
        historyTupleWithCleanEquals(action.historyAfter, action.expectedHistory)
      );
    }) &&
    historyTupleEquals(facts.finalHistory, { pastDepth: 3, futureDepth: 0 }) &&
    facts.finalHistory.baselineClean === false &&
    facts.finalHistory.baselineClean === productBaselineClean(3, 0);

  const meaningSatisfied =
    !harnessInvalid &&
    facts.actions.every(
      (action) =>
        action.transitionObserved &&
        action.meaningStructurallyEqual &&
        action.meaningFingerprint !== null &&
        action.meaningFingerprint === action.expectedMeaningFingerprint,
    );

  const byId: Record<string, boolean> = {
    'history.depth': depthSatisfied,
    'history.meaning': meaningSatisfied,
  };
  const checks: LegacyCompositeCheck[] = [...requiredChecks]
    .sort()
    .map((checkId) => ({ checkId, passed: byId[checkId] ?? false }));

  if (!harnessInvalid && !depthSatisfied) {
    diagnostics.push(
      createDiagnostic(
        'HISTORY_DEPTH_MISMATCH',
        'One or more native Undo/Redo transitions did not produce the exact required history tuple.',
      ),
    );
  }
  if (!harnessInvalid && !meaningSatisfied) {
    diagnostics.push(
      createDiagnostic(
        'HISTORY_MEANING_MISMATCH',
        'One or more native Undo/Redo transitions did not restore the exact expected product meaning.',
      ),
    );
  }

  const primitiveFacts: HistoryPrimitiveFacts = harnessInvalid
    ? malformedHistoryPrimitiveFacts(requiredChecks)
    : primitiveFactsFromChain(facts, requiredChecks, byId);

  return {
    checks,
    passed: depthSatisfied && meaningSatisfied,
    harnessInvalid,
    diagnostics,
    primitiveFacts,
  };
}

/**
 * Projects the raw accepted whole-document chain into the additive primitive
 * facts. Every field is the raw delivered observation (the retained target, the
 * `H0`…`H3` checkpoints, the ordered transitions with their native control
 * identity, revisions, delivered Action Cycle epoch binding, idle observation,
 * and torn-recapture count, and the final tuple) plus the raw pre-action
 * chain-correlation primitive and one explicit per-check predicate. No legacy
 * composite boolean check result is carried.
 */
function primitiveFactsFromChain(
  facts: HistoryEvidenceFacts,
  requiredChecks: readonly string[],
  byId: Readonly<Record<string, boolean>>,
): HistoryPrimitiveFacts {
  const preActionChainCorrelates =
    facts.actions.length > 0 &&
    facts.actions.every((action, index) => {
      const previous =
        index === 0
          ? { pastDepth: 3, futureDepth: 0, baselineClean: false }
          : facts.actions[index - 1]?.historyAfter;
      return previous !== undefined && historyTupleWithCleanEquals(action.historyBefore, previous);
    }) &&
    historyTupleWithCleanEquals(
      facts.finalHistory,
      facts.actions[facts.actions.length - 1]?.historyAfter ?? facts.finalHistory,
    );
  return {
    authority: 'current',
    retainedLayoutId: facts.retainedLayoutId,
    setup: facts.setup.map((entry) => ({
      checkpointId: entry.checkpointId,
      role: entry.role,
      meaning: entry.meaning,
      pastDepth: entry.pastDepth,
      futureDepth: entry.futureDepth,
      baselineClean: entry.baselineClean,
      meaningFingerprint: entry.meaningFingerprint,
    })),
    transitions: facts.actions.map((action, order) => ({
      order,
      stepIndex: action.stepIndex,
      stepId: action.stepId,
      control: action.control,
      controlAccessibleName: action.controlAccessibleName,
      controlTitle: action.controlTitle,
      controlNativeTag: action.controlNativeTag,
      controlButtonType: action.controlButtonType,
      controlVisible: action.controlVisible,
      controlEnabledBeforeDispatch: action.controlEnabledBeforeDispatch,
      dispatchCount: action.dispatchCount,
      actionEpochId:
        typeof (action as { actionEpochId?: unknown }).actionEpochId === 'string'
          ? (action as unknown as { actionEpochId: string }).actionEpochId
          : null,
      observationId: action.observationId,
      preActionRevision: action.preActionRevision,
      postActionRevision: action.postActionRevision,
      revisionAdvanced: action.postActionRevision > action.preActionRevision,
      idle: action.idle === null ? null : { ...action.idle },
      historyBefore: { ...action.historyBefore },
      historyAfter: { ...action.historyAfter },
      expectedHistory: { ...action.expectedHistory },
      historyTupleExact: action.historyTupleExact,
      expectedMeaning: action.expectedMeaning,
      meaningFingerprint: action.meaningFingerprint,
      expectedMeaningFingerprint: action.expectedMeaningFingerprint,
      meaningStructurallyEqual: action.meaningStructurallyEqual,
      transitionObserved: action.transitionObserved,
      tornRecaptureCount: action.tornRecaptureCount,
    })),
    finalHistory: { ...facts.finalHistory },
    preActionChainCorrelates,
    checks: requiredChecks.map((checkId) => ({
      checkId,
      predicateMet: byId[checkId] ?? false,
    })),
  };
}

export const HISTORY_ORACLE_PROFILE = Object.freeze({
  schemaVersion: ORACLE_PROFILE_SCHEMA_VERSION,
  profileId: HISTORY_ORACLE_PROFILE_ID,
  version: HISTORY_ORACLE_PROFILE_VERSION,
});
