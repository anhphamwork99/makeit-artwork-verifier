import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { CHECK_RESULT_CONTRACT_SCHEMA_VERSION } from '../../src/contracts/schema-versions';
import {
  NESTED_OBJECT_AFFINE_CHAIN_KIND,
  NESTED_OBJECT_REQUEST_SCHEMA_VERSION,
  validateNestedObjectRequestV3,
} from '../../src/contracts/geometry-v3';
import {
  HISTORY_ACTION_STEPS,
  HISTORY_CONTROLS,
  HISTORY_CONTROL_BUTTON_TYPE,
  HISTORY_CONTROL_NATIVE_TAG,
  HISTORY_SETUP_CHECKPOINTS,
  productBaselineClean,
} from '../../src/contracts/history-observation';
import { evaluateHistoryOracle } from '../../src/oracles/history';
import type {
  HistoryActionFact,
  HistoryEvidenceFacts,
  HistorySetupFact,
} from '../../src/oracles/history';
import {
  compileResolvedCorrectnessProfile,
  deriveResolvedCorrectnessProfileFingerprint,
  evaluateHistoryChecks,
  historyKernelKindForEvaluator,
  isFullCanonicalFingerprint,
  loadCorrectnessCatalogue,
  projectCorrectnessProfileIdentity,
  resolveRouteSelection,
  validateResultIdentityAgreement,
} from '../../src/index';
import type {
  ActionCycleCorrectnessIdentity,
  CorrectnessCheckResult,
  CorrectnessProfileIdentityView,
  HistoryAuthorityState,
  HistoryEvaluatorFact,
  HistoryEvidenceAvailability,
  HistoryEvidenceFact,
  HistoryKernelFacts,
  HistoryKernelIssueCode,
  HistoryKernelResult,
  HistoryKernelTupleView,
  HistoryOracleFactsView,
  HistoryReadinessFact,
  HistoryReadinessObservationFact,
  ResolvedCorrectnessProfile,
} from '../../src/index';
import type { HistoryOracleEvaluation } from '../../src/oracles/history';

/**
 * P7-B B1-F1 inactive compiled-profile cross-subject History kernel tests
 * (ADR 0028 §3 B1-F, the History half; B1-F2 owns the restore half).
 *
 * The kernel is pure and inactive: it is never reached from an active executor,
 * Oracle, classifier, or writer. These tests drive it directly — including with
 * real `evaluateHistoryOracle` facts over the accepted six-transition contract —
 * and independently re-validate every produced check with the B1-A
 * compiled-profile/result agreement validator. B1-F stays partial after this
 * checkpoint: the frontend serialize/restore kernel is not implemented here.
 */

const ROUTE = { subjectId: 'artwork/editor', capability: 'history' as const, variant: null };

const CHECKS = ['history.depth', 'history.meaning'];

// ── Real accepted history execution facts ────────────────────────────────────

function tuple(pastDepth: number, futureDepth: number): HistoryKernelTupleView {
  return { pastDepth, futureDepth, baselineClean: productBaselineClean(pastDepth, futureDepth) };
}

function setupFacts(): HistorySetupFact[] {
  return HISTORY_SETUP_CHECKPOINTS.map((entry) => ({
    checkpointId: entry.checkpointId,
    role: entry.role,
    pastDepth: entry.pastDepth,
    futureDepth: entry.futureDepth,
    baselineClean: productBaselineClean(entry.pastDepth, entry.futureDepth),
    meaning: entry.meaning,
    meaningFingerprint: 'a'.repeat(64),
  }));
}

/** The product-exact pre-action chain: H3 then each prior post-action tuple. */
function beforeFor(index: number): HistoryKernelTupleView {
  if (index === 0) return tuple(3, 0);
  const prior = HISTORY_ACTION_STEPS[index - 1]?.expectedHistory;
  return prior === undefined
    ? tuple(3, 0)
    : {
        pastDepth: prior.pastDepth,
        futureDepth: prior.futureDepth,
        baselineClean: prior.baselineClean,
      };
}

function actionFacts(): HistoryActionFact[] {
  return HISTORY_ACTION_STEPS.map((step) => {
    const preActionRevision = 10 + step.stepIndex * 2;
    const postActionRevision = preActionRevision + 1;
    return {
      stepIndex: step.stepIndex,
      stepId: step.stepId,
      control: step.control,
      controlAccessibleName: HISTORY_CONTROLS[step.control].accessibleName,
      controlTitle: HISTORY_CONTROLS[step.control].title,
      controlNativeTag: HISTORY_CONTROL_NATIVE_TAG,
      controlButtonType: HISTORY_CONTROL_BUTTON_TYPE,
      controlVisible: true,
      controlEnabledBeforeDispatch: true,
      dispatchCount: 1,
      preActionRevision,
      postActionRevision,
      historyBefore: beforeFor(step.stepIndex),
      historyAfter: { ...step.expectedHistory },
      expectedHistory: { ...step.expectedHistory },
      historyTupleExact: true,
      expectedMeaning: step.expectedMeaning,
      meaningFingerprint: 'b'.repeat(64),
      expectedMeaningFingerprint: 'b'.repeat(64),
      meaningStructurallyEqual: true,
      observationId: `history:${step.stepId}:${postActionRevision}`,
      idle: { stableFrames: 3, waitedMs: 40, observationRevision: postActionRevision },
      tornRecaptureCount: 0,
      transitionObserved: true,
    };
  });
}

function evidenceFacts(overrides: Partial<HistoryEvidenceFacts> = {}): HistoryEvidenceFacts {
  return {
    retainedLayoutId: 'layout-a',
    setup: setupFacts(),
    actions: actionFacts(),
    finalHistory: tuple(3, 0),
    ...overrides,
  };
}

// ── Kernel scaffolding ───────────────────────────────────────────────────────

const catalogue = loadCorrectnessCatalogue();

function compile(): ResolvedCorrectnessProfile {
  const selection = resolveRouteSelection(catalogue, ROUTE);
  if (selection === null) throw new Error('missing cross-subject History route selection');
  // The planner compiles this route with the Subject binding's declared
  // `history.depth` check; this is the exact runtime compiled profile.
  const compiled = compileResolvedCorrectnessProfile({
    catalogue,
    selection,
    declaredChecks: ['history.depth'],
  });
  if (!compiled.ok) throw new Error('cross-subject History route failed to compile');
  return compiled.profile;
}

const profile = compile();
const identity = projectCorrectnessProfileIdentity(profile);

function cycle(
  source: ResolvedCorrectnessProfile = profile,
  id = 'action-cycle-history-1',
): ActionCycleCorrectnessIdentity {
  return {
    schemaVersion: CHECK_RESULT_CONTRACT_SCHEMA_VERSION,
    actionCycleId: id,
    resolvedProfileFingerprint: source.resolvedFingerprint,
    readinessFingerprint: source.componentFingerprints.readiness,
  };
}

function readinessFact(
  source: ResolvedCorrectnessProfile = profile,
  observation: Partial<HistoryReadinessObservationFact> = {},
): HistoryReadinessFact {
  return {
    policy: {
      profileId: source.readiness.profileId,
      deadlineCategory: source.readiness.deadlineCategory,
      deadlineMs: source.readiness.deadlineMs,
      signalWatchdogMs: source.readiness.signalWatchdogMs,
      fallbackCadenceMs: [...source.readiness.fallbackCadenceMs],
      stableFrames: source.readiness.stableFrames,
      quiescenceRequired: source.readiness.quiescenceRequired,
      stableFrameRequired: source.readiness.stableFrameRequired,
    },
    observation: {
      outcome: 'signal',
      wakeSource: 'store-signal',
      fallbackPollCount: 0,
      watchdogWaits: 0,
      observedStableFrames: source.readiness.stableFrames,
      detail: null,
      ...observation,
    },
  };
}

function evidenceAll(
  source: ResolvedCorrectnessProfile = profile,
  overrides: Readonly<Record<string, HistoryEvidenceAvailability>> = {},
): HistoryEvidenceFact[] {
  return source.requiredAuthoritativeEvidence.map((evidenceId) => ({
    evidenceId,
    availability: overrides[evidenceId] ?? 'authoritative',
  }));
}

/** Projects the delivered Oracle's additive primitive checks into structured facts. */
function structuredChecks(evaluation: HistoryOracleEvaluation): HistoryEvaluatorFact[] {
  const authority = evaluation.primitiveFacts.authority === 'malformed' ? 'malformed' : 'current';
  const sourcesAgree = evaluation.primitiveFacts.preActionChainCorrelates === true;
  return evaluation.primitiveFacts.checks.map((check) => ({
    checkId: check.checkId,
    authority,
    currentness: authority === 'current' ? 'current' : 'unavailable',
    sourcesAgree,
    mismatch: authority === 'malformed' ? false : check.predicateMet !== true,
  }));
}

/** Projects the delivered Oracle's additive primitive facts into the raw view. */
function oracleFactsOf(evaluation: HistoryOracleEvaluation): HistoryOracleFactsView {
  return {
    authority: evaluation.primitiveFacts.authority,
    chainAgreement: evaluation.primitiveFacts.preActionChainCorrelates === true,
    retainedLayoutId: evaluation.primitiveFacts.retainedLayoutId,
    setup:
      evaluation.primitiveFacts.setup === null
        ? null
        : evaluation.primitiveFacts.setup.map((entry) => ({ ...entry })),
    transitions:
      evaluation.primitiveFacts.transitions === null
        ? null
        : evaluation.primitiveFacts.transitions.map((entry) => ({ ...entry })),
    finalHistory:
      evaluation.primitiveFacts.finalHistory === null
        ? null
        : { ...evaluation.primitiveFacts.finalHistory },
    checks: evaluation.primitiveFacts.checks.map((check) => ({
      checkId: check.checkId,
      predicateMet: check.predicateMet === true,
    })),
  };
}

function factsFor(
  evidence: HistoryEvidenceFacts = evidenceFacts(),
  overrides: Partial<HistoryKernelFacts> = {},
): HistoryKernelFacts {
  const evaluation = evaluateHistoryOracle(evidence);
  return {
    evaluator: 'history-cross-subject',
    retainedLayoutId: evidence.retainedLayoutId,
    setup: evidence.setup,
    actions: evidence.actions,
    finalHistory: evidence.finalHistory,
    readiness: readinessFact(),
    checks: structuredChecks(evaluation),
    oracleFacts: oracleFactsOf(evaluation),
    diagnostics: evaluation.diagnostics.map((entry) => ({
      code: entry.code,
      detail: entry.detail,
    })),
    evidence: evidenceAll(),
    ...overrides,
  };
}

function run(
  facts: HistoryKernelFacts,
  source: ResolvedCorrectnessProfile = profile,
): HistoryKernelResult {
  return evaluateHistoryChecks({
    profile: source,
    route: ROUTE,
    actionCycle: cycle(source),
    facts,
  });
}

function codes(result: HistoryKernelResult): HistoryKernelIssueCode[] {
  return result.issues.map((entry) => entry.code);
}

function statusFor(result: HistoryKernelResult, checkId: string): string | undefined {
  return result.checks.find((check) => check.checkId === checkId)?.status;
}

function checkFor(result: HistoryKernelResult, checkId: string): CorrectnessCheckResult {
  const check = result.checks.find((candidate) => candidate.checkId === checkId);
  if (check === undefined) throw new Error(`missing check ${checkId}`);
  return check;
}

function agreement(
  view: CorrectnessProfileIdentityView,
  aCycle: ActionCycleCorrectnessIdentity,
  checks: readonly CorrectnessCheckResult[],
) {
  return validateResultIdentityAgreement(view, { actionCycles: [aCycle], requiredChecks: checks });
}

function tamperedProfile(mutate: (profile: Record<string, unknown>) => void) {
  const clone = structuredClone(profile) as unknown as Record<string, unknown>;
  mutate(clone);
  return clone as unknown as ResolvedCorrectnessProfile;
}

/** Recomputes oracle facts from a coherently mutated evidence chain. */
// ── Positive results ─────────────────────────────────────────────────────────

describe('[P7-B B1-F1] cross-subject History kernel positive results', () => {
  it('produces a complete PASS result for every declared check from real Oracle facts', () => {
    const evidence = evidenceFacts();
    const evaluation = evaluateHistoryOracle(evidence);
    expect(evaluation.harnessInvalid).toBe(false);
    expect(evaluation.checks.every((check) => check.passed)).toBe(true);

    const result = run(factsFor(evidence));
    expect(result.ok).toBe(true);
    expect(result.kind).toBe('history-cross-subject');
    expect(result.checks.map((check) => check.checkId)).toEqual(CHECKS);
    expect(result.checks).toHaveLength(profile.requiredChecks.length);

    for (const check of result.checks) {
      expect(check.status).toBe('PASS');
      expect(check.schemaVersion).toBe(CHECK_RESULT_CONTRACT_SCHEMA_VERSION);
      expect(check.evidenceIds).toEqual(
        [
          ...(profile.requiredChecks.find((entry) => entry.checkId === check.checkId)
            ?.requiredEvidence ?? []),
        ].sort(),
      );
      expect(check.visualRefs).toEqual([]);
      expect(check.toleranceRefs).toEqual([]);
      expect(check.normalizationRef).toBeNull();
      expect(check.actionCycleRef).toBe('action-cycle-history-1');
      expect(check.actual.authority).toBe('current');
      expect(check.actual.authorityScope).toBeNull();
      expect(Object.hasOwn(check, 'passed')).toBe(false);
      expect(Object.hasOwn(check.actual, 'harnessInvalid')).toBe(false);
      expect(Object.hasOwn(check.actual.oracle as object, 'passed')).toBe(false);
    }
    expect(agreement(identity, cycle(), result.checks).ok).toBe(true);
  });

  it('carries the exact compiled check schemas and consumed component fingerprints', () => {
    const result = run(factsFor());
    for (const contract of profile.requiredChecks) {
      const check = checkFor(result, contract.checkId);
      expect(check.expected.schema).toBe(contract.expectedSchema);
      expect(check.actual.schema).toBe(contract.actualSchema);
      expect(check.actual.checkId).toBeUndefined();
      expect(check.consumedComponentFingerprints).toEqual({
        resolvedProfile: profile.resolvedFingerprint,
        requiredCheckSet: profile.componentFingerprints.requiredCheckSet,
        oracle: profile.componentFingerprints.oracle,
        capture: profile.componentFingerprints.capture,
        tolerances: profile.componentFingerprints.tolerances,
        visuals: profile.componentFingerprints.visuals,
        normalization: profile.componentFingerprints.normalization,
      });
    }
    expect(profile.requiredChecks.map((entry) => entry.checkId)).toEqual(CHECKS);
    expect(profile.oracle.evaluatorKind).toBe('history-cross-subject');
  });

  it('publishes the exact pre-action baseline, cross-subject identities, order, and currentness', () => {
    const result = run(factsFor());
    const depth = checkFor(result, 'history.depth');

    // Exact pre-action baseline: H3 is the head of the six-transition chain.
    expect(depth.expected.preActionBaseline).toEqual({
      pastDepth: 3,
      futureDepth: 0,
      baselineClean: false,
    });
    expect(depth.actual.preActionBaseline).toEqual({
      pastDepth: 3,
      futureDepth: 0,
      baselineClean: false,
    });

    // Cross-subject setup identities: the exact H0…H3 construction.
    expect(depth.expected.setupCheckpoints).toEqual(
      HISTORY_SETUP_CHECKPOINTS.map((entry) => ({
        checkpointId: entry.checkpointId,
        role: entry.role,
        pastDepth: entry.pastDepth,
        futureDepth: entry.futureDepth,
        baselineClean: productBaselineClean(entry.pastDepth, entry.futureDepth),
        meaning: entry.meaning,
      })),
    );
    const actualSetup = depth.actual.setup as readonly Record<string, unknown>[];
    expect(actualSetup.map((entry) => entry.role)).toEqual([
      'sealed-host',
      'created-text',
      'created-image-placeholder',
      'created-crossword',
    ]);
    expect(actualSetup.map((entry) => entry.meaning)).toEqual(['M0', 'M1', 'M2', 'M3']);
    expect(actualSetup.every((entry) => entry.baselineCleanProductExact === true)).toBe(true);

    // Undo/Redo identity, order, and currentness.
    const transitions = depth.actual.transitions as readonly Record<string, unknown>[];
    expect(transitions).toHaveLength(6);
    expect(transitions.map((entry) => entry.control)).toEqual([
      'undo',
      'undo',
      'undo',
      'redo',
      'redo',
      'redo',
    ]);
    expect(transitions.map((entry) => entry.order)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(transitions.map((entry) => entry.stepId)).toEqual(
      HISTORY_ACTION_STEPS.map((step) => step.stepId),
    );
    expect(
      transitions.every(
        (entry) =>
          entry.controlNativeTag === HISTORY_CONTROL_NATIVE_TAG &&
          entry.controlButtonType === HISTORY_CONTROL_BUTTON_TYPE &&
          entry.controlVisible === true &&
          entry.controlEnabledBeforeDispatch === true &&
          entry.dispatchCount === 1,
      ),
    ).toBe(true);
    expect(transitions.every((entry) => entry.revisionAdvanced === true)).toBe(true);
    expect(transitions.every((entry) => entry.idleCurrent === true)).toBe(true);
    expect(transitions.every((entry) => entry.transitionObserved === true)).toBe(true);
    expect(transitions.every((entry) => entry.meaningFingerprintEqual === true)).toBe(true);
    expect(depth.actual.finalHistory).toEqual({
      pastDepth: 3,
      futureDepth: 0,
      baselineClean: false,
    });
    expect(depth.actual.retainedLayoutId).toBe('layout-a');

    // Expected identity/order contract.
    const expectedTransitions = depth.expected.transitions as readonly Record<string, unknown>[];
    expect(expectedTransitions).toHaveLength(6);
    expect(expectedTransitions.map((entry) => entry.controlAccessibleName)).toEqual([
      HISTORY_CONTROLS.undo.accessibleName,
      HISTORY_CONTROLS.undo.accessibleName,
      HISTORY_CONTROLS.undo.accessibleName,
      HISTORY_CONTROLS.redo.accessibleName,
      HISTORY_CONTROLS.redo.accessibleName,
      HISTORY_CONTROLS.redo.accessibleName,
    ]);
    expect(expectedTransitions.map((entry) => entry.expectedMeaning)).toEqual([
      'M2',
      'M1',
      'M0',
      'M1',
      'M2',
      'M3',
    ]);
  });

  it('carries the compiled readiness policy and the accepted signal-first observation', () => {
    const result = run(factsFor());
    const actual = checkFor(result, 'history.depth').actual.readiness as Record<string, unknown>;
    expect(actual.profileId).toBe(profile.readiness.profileId);
    expect(actual.deadlineCategory).toBe('INTERACTIVE_HISTORY_V1');
    expect(actual.deadlineMs).toBe(profile.readiness.deadlineMs);
    expect(actual.outcome).toBe('signal');
    expect(actual.observedStableFrames).toBe(profile.readiness.stableFrames);
    const expected = checkFor(result, 'history.depth').expected;
    expect(expected.readinessProfileId).toBe(profile.readiness.profileId);
    expect(expected.timingCategory).toBe('INTERACTIVE_HISTORY_V1');
    expect(expected.deadlineMs).toBe(5000);
  });

  it('structurally accepts the delivered HistoryOracleEvaluation fact projection', () => {
    const evaluation = evaluateHistoryOracle(evidenceFacts());
    const facts: HistoryKernelFacts = {
      evaluator: 'history-cross-subject',
      retainedLayoutId: 'layout-a',
      setup: evidenceFacts().setup,
      actions: evidenceFacts().actions,
      finalHistory: evidenceFacts().finalHistory,
      readiness: readinessFact(),
      checks: structuredChecks(evaluation),
      oracleFacts: oracleFactsOf(evaluation),
      diagnostics: evaluation.diagnostics.map((entry) => ({
        code: entry.code,
        detail: entry.detail,
      })),
      evidence: evidenceAll(),
    };
    expect(Object.hasOwn(facts, 'harnessInvalid')).toBe(false);
    for (const check of facts.checks) {
      expect(Object.hasOwn(check, 'passed')).toBe(false);
    }
    expect(run(facts).checks.every((check) => check.status === 'PASS')).toBe(true);
  });

  it('consumes exactly the compiled required evidence for every passing check', () => {
    const result = run(factsFor());
    const depth = checkFor(result, 'history.depth');
    const meaning = checkFor(result, 'history.meaning');
    expect(depth.evidenceIds).toEqual([
      'history.source-snapshot',
      'history.transition-snapshot',
      'observation',
    ]);
    expect(meaning.evidenceIds).toEqual(['history.source-snapshot', 'history.transition-snapshot']);
    expect(depth.actual.consumedEvidence).toEqual(depth.evidenceIds);
    expect(meaning.actual.consumedEvidence).toEqual(meaning.evidenceIds);
    expect(agreement(identity, cycle(), result.checks).ok).toBe(true);
  });
});

// ── Trustworthy product mismatch → FAIL ──────────────────────────────────────

/** Returns a copy of the evidence with a coherently mutated transition chain. */
function withActions(
  evidence: HistoryEvidenceFacts,
  mutate: (actions: HistoryActionFact[]) => void,
  overrides: Partial<HistoryEvidenceFacts> = {},
): HistoryEvidenceFacts {
  const actions = [...evidence.actions];
  mutate(actions);
  return { ...evidence, actions, ...overrides };
}

describe('[P7-B B1-F1] trustworthy mismatch maps to FAIL', () => {
  it('fails only the depth check for a coherent wrong final transition tuple', () => {
    // The last redo-3 fails to return to H3: the product settles at 2/1 while
    // every baseline still correlates exactly with the previous state.
    const evidence = withActions(
      evidenceFacts(),
      (actions) => {
        actions[5] = { ...actions[5], historyAfter: tuple(2, 1) } as HistoryActionFact;
      },
      { finalHistory: tuple(2, 1) },
    );

    const evaluation = evaluateHistoryOracle(evidence);
    expect(evaluation.harnessInvalid).toBe(false);
    expect(evaluation.checks.find((check) => check.checkId === 'history.depth')?.passed).toBe(
      false,
    );

    const result = run(factsFor(evidence));
    expect(result.ok).toBe(true);
    expect(statusFor(result, 'history.depth')).toBe('FAIL');
    expect(statusFor(result, 'history.meaning')).toBe('PASS');
    expect(checkFor(result, 'history.depth').actual.authority).toBe('current');
    expect(checkFor(result, 'history.depth').actual.preActionBaseline).toEqual({
      pastDepth: 3,
      futureDepth: 0,
      baselineClean: false,
    });
    expect(agreement(identity, cycle(), result.checks).ok).toBe(true);
  });

  it('fails only the meaning check for a coherently restored wrong normalized meaning', () => {
    const evidence = withActions(evidenceFacts(), (actions) => {
      actions[2] = {
        ...actions[2],
        meaningFingerprint: 'c'.repeat(64),
        meaningStructurallyEqual: true,
      } as HistoryActionFact;
    });

    const evaluation = evaluateHistoryOracle(evidence);
    expect(evaluation.harnessInvalid).toBe(false);
    expect(evaluation.checks.find((check) => check.checkId === 'history.meaning')?.passed).toBe(
      false,
    );

    const result = run(factsFor(evidence));
    expect(statusFor(result, 'history.meaning')).toBe('FAIL');
    expect(statusFor(result, 'history.depth')).toBe('PASS');
    const transitions = checkFor(result, 'history.meaning').actual.transitions as readonly Record<
      string,
      unknown
    >[];
    expect(transitions[2]?.meaningFingerprintEqual).toBe(false);
    expect(checkFor(result, 'history.meaning').actual.authority).toBe('current');
  });

  it('fails only the meaning check for a structurally unequal restored meaning', () => {
    const evidence = withActions(evidenceFacts(), (actions) => {
      actions[4] = { ...actions[4], meaningStructurallyEqual: false } as HistoryActionFact;
    });
    const evaluation = evaluateHistoryOracle(evidence);
    expect(evaluation.harnessInvalid).toBe(false);
    const result = run(factsFor(evidence));
    expect(statusFor(result, 'history.meaning')).toBe('FAIL');
    expect(statusFor(result, 'history.depth')).toBe('PASS');
    const transitions = checkFor(result, 'history.meaning').actual.transitions as readonly Record<
      string,
      unknown
    >[];
    expect(transitions[4]?.meaningStructurallyEqual).toBe(false);
  });

  it('never lets one failing check rescue the other', () => {
    const evidence = withActions(
      evidenceFacts(),
      (actions) => {
        actions[5] = { ...actions[5], historyAfter: tuple(2, 1) } as HistoryActionFact;
        actions[1] = { ...actions[1], meaningStructurallyEqual: false } as HistoryActionFact;
      },
      { finalHistory: tuple(2, 1) },
    );
    const result = run(factsFor(evidence));
    expect(statusFor(result, 'history.depth')).toBe('FAIL');
    expect(statusFor(result, 'history.meaning')).toBe('FAIL');
    expect(result.checks.every((check) => check.actual.authority === 'current')).toBe(true);
  });

  it('recomputes the expected tuple from the accepted contract, not the delivered expectation', () => {
    const evidence = withActions(evidenceFacts(), (actions) => {
      actions[0] = {
        ...actions[0],
        expectedHistory: tuple(1, 1),
        historyTupleExact: true,
      } as HistoryActionFact;
    });
    const result = run(factsFor(evidence));
    // A driver-declared expectation that contradicts the accepted contract is
    // malformed authority, never a trustworthy product mismatch.
    expect(statusFor(result, 'history.depth')).toBe('UNUSABLE');
    expect(codes(result)).toContain('HISTORY_KERNEL_EXECUTION_AUTHORITY_UNUSABLE');
  });
});

// ── Missing/stale/torn/ambiguous/wrong-target authority → UNUSABLE ───────────

describe('[P7-B B1-F1] unusable authority maps to UNUSABLE', () => {
  it('is UNUSABLE for every check when the setup checkpoints are absent', () => {
    const result = run(factsFor(evidenceFacts({ setup: [] })));
    expect(result.ok).toBe(true);
    expect(result.checks.every((check) => check.status === 'UNUSABLE')).toBe(true);
    expect(result.checks.every((check) => check.actual.authority === 'missing')).toBe(true);
    expect(codes(result)).toContain('HISTORY_KERNEL_EXECUTION_AUTHORITY_UNUSABLE');
  });

  it('is UNUSABLE for every check when the transitions are absent', () => {
    const result = run(factsFor(evidenceFacts({ actions: [] })));
    expect(result.checks.every((check) => check.status === 'UNUSABLE')).toBe(true);
    expect(result.checks.every((check) => check.actual.authority === 'missing')).toBe(true);
  });

  it('is UNUSABLE (ambiguous) for a duplicated transition chain', () => {
    const evidence = evidenceFacts();
    const actions = [...evidence.actions];
    actions.push(actions[0] as HistoryActionFact);
    const result = run(factsFor({ ...evidence, actions }));
    expect(result.checks.every((check) => check.status === 'UNUSABLE')).toBe(true);
    expect(result.checks.every((check) => check.actual.authority === 'ambiguous')).toBe(true);
  });

  it('is UNUSABLE (malformed) for a non-object setup checkpoint', () => {
    const evidence = evidenceFacts();
    const setup = [...evidence.setup];
    setup[1] = 'not-a-checkpoint' as unknown as HistorySetupFact;
    const result = run(factsFor({ ...evidence, setup }));
    expect(result.checks.every((check) => check.actual.authority === 'malformed')).toBe(true);
  });

  it('is UNUSABLE (malformed) for a wrong cross-subject setup role', () => {
    const evidence = evidenceFacts();
    const setup = [...evidence.setup];
    setup[2] = { ...setup[2], role: 'created-vector' } as HistorySetupFact;
    const result = run(factsFor({ ...evidence, setup }));
    expect(result.checks.every((check) => check.status === 'UNUSABLE')).toBe(true);
    expect(result.checks.every((check) => check.actual.authority === 'malformed')).toBe(true);
  });

  it('is UNUSABLE (malformed) for a non-native or mislabelled Undo/Redo control', () => {
    for (const mutate of [
      (action: Record<string, unknown>) => {
        action.controlNativeTag = 'DIV';
      },
      (action: Record<string, unknown>) => {
        action.controlButtonType = null;
      },
      (action: Record<string, unknown>) => {
        action.controlTitle = 'Undo (⌘Z)';
      },
      (action: Record<string, unknown>) => {
        action.controlAccessibleName = 'Undo';
      },
      (action: Record<string, unknown>) => {
        action.controlVisible = false;
      },
      (action: Record<string, unknown>) => {
        action.controlEnabledBeforeDispatch = false;
      },
    ]) {
      const evidence = evidenceFacts();
      const actions = [...evidence.actions];
      const target = { ...actions[3] } as unknown as Record<string, unknown>;
      mutate(target);
      actions[3] = target as unknown as HistoryActionFact;
      const result = run(factsFor({ ...evidence, actions }));
      expect(result.checks.every((check) => check.status === 'UNUSABLE')).toBe(true);
      expect(result.checks.every((check) => check.actual.authority === 'malformed')).toBe(true);
    }
  });

  it('is UNUSABLE (malformed) for a transition outside the accepted order', () => {
    const evidence = evidenceFacts();
    const actions = [...evidence.actions];
    actions[2] = { ...actions[2], stepId: 'history.undo-4' } as HistoryActionFact;
    const result = run(factsFor({ ...evidence, actions }));
    expect(result.checks.every((check) => check.actual.authority === 'malformed')).toBe(true);
  });

  it('is UNUSABLE (stale) for a post-action revision that does not advance', () => {
    const evidence = evidenceFacts();
    const actions = [...evidence.actions];
    actions[1] = {
      ...actions[1],
      postActionRevision: actions[1].preActionRevision,
      observationId: `history:${actions[1].stepId}:${actions[1].preActionRevision}`,
      idle: { ...actions[1].idle!, observationRevision: actions[1].preActionRevision },
    } as HistoryActionFact;
    const result = run(factsFor({ ...evidence, actions }));
    expect(result.checks.every((check) => check.status === 'UNUSABLE')).toBe(true);
    expect(result.checks.every((check) => check.actual.authority === 'stale')).toBe(true);
    expect(codes(result)).toContain('HISTORY_KERNEL_PRE_ACTION_AUTHORITY_UNUSABLE');
  });

  it('is UNUSABLE (stale) for a stale idle observation revision', () => {
    const evidence = evidenceFacts();
    const actions = [...evidence.actions];
    actions[2] = {
      ...actions[2],
      idle: { ...actions[2].idle!, observationRevision: 999 },
    } as HistoryActionFact;
    const result = run(factsFor({ ...evidence, actions }));
    expect(result.checks.every((check) => check.actual.authority === 'stale')).toBe(true);
  });

  it('is UNUSABLE (stale) for an idle observation below the compiled stable frames', () => {
    const evidence = evidenceFacts();
    const actions = [...evidence.actions];
    actions[4] = {
      ...actions[4],
      idle: { ...actions[4].idle!, stableFrames: 1 },
    } as HistoryActionFact;
    const result = run(factsFor({ ...evidence, actions }));
    expect(result.checks.every((check) => check.status === 'UNUSABLE')).toBe(true);
    expect(result.checks.every((check) => check.actual.authority === 'stale')).toBe(true);
  });

  it('is UNUSABLE (stale) for an observation identity not bound to its revision', () => {
    const evidence = evidenceFacts();
    const actions = [...evidence.actions];
    actions[0] = {
      ...actions[0],
      observationId: 'history:history.undo-1:999',
    } as HistoryActionFact;
    const result = run(factsFor({ ...evidence, actions }));
    expect(result.checks.every((check) => check.actual.authority === 'stale')).toBe(true);
  });

  it('is UNUSABLE (stale) for a present Action Cycle epoch identity bound to a different revision', () => {
    const evidence = evidenceFacts();
    const actions = [...evidence.actions].map((action) => ({
      ...action,
      actionEpochId: `history:${action.stepId}:${action.postActionRevision + 5}`,
    }));
    const result = run(factsFor({ ...evidence, actions }));
    expect(result.checks.every((check) => check.status === 'UNUSABLE')).toBe(true);
    expect(result.checks.every((check) => check.actual.authority === 'stale')).toBe(true);
  });

  it('is UNUSABLE (missing) when a required observation identity is absent', () => {
    const evidence = evidenceFacts();
    const actions = [...evidence.actions];
    actions[3] = { ...actions[3], observationId: null } as unknown as HistoryActionFact;
    const result = run(factsFor({ ...evidence, actions }));
    expect(result.checks.every((check) => check.actual.authority === 'missing')).toBe(true);
  });

  it('is UNUSABLE (ambiguous) for a reused observation identity', () => {
    const evidence = evidenceFacts();
    const actions = [...evidence.actions];
    actions[5] = { ...actions[5], observationId: actions[4].observationId } as HistoryActionFact;
    const result = run(factsFor({ ...evidence, actions }));
    expect(result.checks.every((check) => check.actual.authority === 'ambiguous')).toBe(true);
  });

  it('is UNUSABLE (torn) for a recaptured torn candidate', () => {
    const evidence = evidenceFacts();
    const actions = [...evidence.actions];
    actions[2] = { ...actions[2], tornRecaptureCount: 1 } as HistoryActionFact;
    const result = run(factsFor({ ...evidence, actions }));
    expect(result.checks.every((check) => check.status === 'UNUSABLE')).toBe(true);
    expect(result.checks.every((check) => check.actual.authority === 'torn')).toBe(true);
    expect(result.checks.every((check) => check.actual.authorityScope === 'pre-action')).toBe(true);
  });

  it('is UNUSABLE (missing) when no causal transition was observed', () => {
    const evidence = evidenceFacts();
    const actions = [...evidence.actions];
    actions[1] = { ...actions[1], transitionObserved: false } as HistoryActionFact;
    const result = run(factsFor({ ...evidence, actions }));
    expect(result.checks.every((check) => check.actual.authority === 'missing')).toBe(true);
  });

  it('is UNUSABLE (wrong-target) for an empty retained Layout identity', () => {
    const result = run(factsFor(evidenceFacts({ retainedLayoutId: '' })));
    expect(result.checks.every((check) => check.status === 'UNUSABLE')).toBe(true);
    expect(result.checks.every((check) => check.actual.authority === 'wrong-target')).toBe(true);
    expect(codes(result)).toContain('HISTORY_KERNEL_TARGET_AUTHORITY_UNUSABLE');
  });

  it('is UNUSABLE (missing) for an absent retained Layout identity', () => {
    const result = run(factsFor(evidenceFacts({ retainedLayoutId: null as unknown as string })));
    expect(result.checks.every((check) => check.actual.authority === 'missing')).toBe(true);
  });

  it('is UNUSABLE for a final tuple that does not correlate with the last transition', () => {
    const evidence = evidenceFacts();
    // The delivered Oracle facts still claim PASS; the inconsistent final tuple
    // is unusable authority and no boolean fact may rescue it.
    const result = run(factsFor({ ...evidence, finalHistory: tuple(1, 2) }));
    expect(result.checks.every((check) => check.status === 'UNUSABLE')).toBe(true);
    expect(result.checks.every((check) => check.actual.authority === 'stale')).toBe(true);
  });

  it('is UNUSABLE for a readiness timeout and for an invalidated chain', () => {
    for (const observation of [
      { outcome: 'timeout' as const },
      { outcome: 'invalidated' as const },
      { outcome: 'unavailable' as const },
      { outcome: 'stale' as const },
    ]) {
      const result = run(
        factsFor(evidenceFacts(), { readiness: readinessFact(profile, observation) }),
      );
      expect(result.checks.every((check) => check.status === 'UNUSABLE')).toBe(true);
      expect(codes(result)).toContain('HISTORY_KERNEL_READINESS_AUTHORITY_UNUSABLE');
    }
  });

  it('is UNUSABLE (malformed) for a readiness policy that diverges from the compiled authority', () => {
    const weakened = readinessFact();
    const result = run(
      factsFor(evidenceFacts(), {
        readiness: {
          ...weakened,
          policy: { ...weakened.policy, deadlineMs: 6000 },
        },
      }),
    );
    expect(result.checks.every((check) => check.status === 'UNUSABLE')).toBe(true);
    expect(result.checks.every((check) => check.actual.authority === 'malformed')).toBe(true);
    expect(codes(result)).toContain('HISTORY_KERNEL_READINESS_POLICY_MISMATCH');
  });

  it('is UNUSABLE (malformed) when the accepted evaluator authority is malformed', () => {
    const facts = factsFor();
    const result = run({
      ...facts,
      checks: facts.checks.map((check) => ({
        ...check,
        authority: 'malformed' as HistoryAuthorityState,
        currentness: 'unavailable' as const,
        mismatch: false,
      })),
      oracleFacts:
        facts.oracleFacts === null
          ? null
          : { ...facts.oracleFacts, authority: 'malformed' as const, chainAgreement: false },
    });
    expect(result.checks.every((check) => check.status === 'UNUSABLE')).toBe(true);
    expect(result.checks.every((check) => check.actual.authority === 'malformed')).toBe(true);
  });

  it('is UNUSABLE (missing) for a declared check with no accepted fact', () => {
    const facts = factsFor();
    const result = run({
      ...facts,
      checks: facts.checks.filter((check) => check.checkId !== 'history.meaning'),
    });
    expect(statusFor(result, 'history.meaning')).toBe('UNUSABLE');
    expect(statusFor(result, 'history.depth')).toBe('PASS');
    expect(checkFor(result, 'history.meaning').actual.authority).toBe('missing');
    expect(codes(result)).toContain('HISTORY_KERNEL_FACT_CHECK_MISSING');
  });

  it('never lets a delivered passing fact rescue unusable authority', () => {
    const evidence = evidenceFacts();
    const actions = [...evidence.actions];
    actions[0] = { ...actions[0], tornRecaptureCount: 2 } as HistoryActionFact;
    // The delivered facts still claim both checks passed.
    const facts = factsFor({ ...evidence, actions });
    expect(evaluateHistoryOracle(evidence).checks.every((check) => check.passed)).toBe(true);
    const result = run(facts);
    expect(result.checks.every((check) => check.status === 'UNUSABLE')).toBe(true);
  });
});

// ── Required evidence and diagnostic isolation ───────────────────────────────

describe('[P7-B B1-F1] required evidence and diagnostic isolation', () => {
  it('is UNUSABLE for the dependent checks when required authority is torn', () => {
    const result = run(
      factsFor(evidenceFacts(), {
        evidence: evidenceAll(profile, { 'history.transition-snapshot': 'torn' }),
      }),
    );
    expect(result.checks.every((check) => check.status === 'UNUSABLE')).toBe(true);
    for (const check of result.checks) {
      expect(check.evidenceIds).not.toContain('history.transition-snapshot');
      expect(check.actual.authority).toBe('torn');
    }
    expect(agreement(identity, cycle(), result.checks).ok).toBe(true);
  });

  it('is UNUSABLE only for the checks that require a missing evidence item', () => {
    const result = run(
      factsFor(evidenceFacts(), {
        evidence: evidenceAll(profile, { observation: 'missing' }),
      }),
    );
    expect(statusFor(result, 'history.depth')).toBe('UNUSABLE');
    expect(statusFor(result, 'history.meaning')).toBe('PASS');
    expect(checkFor(result, 'history.depth').actual.authority).toBe('missing');
    expect(checkFor(result, 'history.depth').evidenceIds).toEqual([
      'history.source-snapshot',
      'history.transition-snapshot',
    ]);
  });

  it('never consumes a diagnostic-only item declared for required authority', () => {
    const result = run(
      factsFor(evidenceFacts(), {
        evidence: evidenceAll(profile, { 'history.source-snapshot': 'diagnostic-only' }),
      }),
    );
    expect(result.checks.every((check) => check.status === 'UNUSABLE')).toBe(true);
    expect(codes(result)).toContain('HISTORY_KERNEL_EVIDENCE_DIAGNOSTIC_ONLY');
    for (const check of result.checks) {
      expect(check.evidenceIds).not.toContain('history.source-snapshot');
    }
  });

  it('reports undeclared evidence claiming authority without consuming it', () => {
    const facts = factsFor();
    const result = run({
      ...facts,
      evidence: [
        ...facts.evidence,
        { evidenceId: 'uncalibrated.extra', availability: 'authoritative' },
      ],
    });
    expect(codes(result)).toContain('HISTORY_KERNEL_EVIDENCE_UNDECLARED');
    for (const check of result.checks) {
      expect(check.evidenceIds).not.toContain('uncalibrated.extra');
    }
  });

  it('ignores a diagnostic-only unrequired item entirely', () => {
    const facts = factsFor();
    const result = run({
      ...facts,
      evidence: [
        ...facts.evidence,
        { evidenceId: 'history.raw-payload.diagnostic', availability: 'diagnostic-only' },
        { evidenceId: 'screenshot.diagnostic', availability: 'diagnostic-only' },
      ],
    });
    expect(result.checks.every((check) => check.status === 'PASS')).toBe(true);
    expect(codes(result)).not.toContain('HISTORY_KERNEL_EVIDENCE_DIAGNOSTIC_ONLY');
  });
});

// ── Identity, route, Action Cycle, and check-evaluator agreement ─────────────

describe('[P7-B B1-F1] compiled-profile identity agreement', () => {
  it('rejects a profile for a different route without fabricating checks', () => {
    const result = evaluateHistoryChecks({
      profile,
      route: { subjectId: 'container/layout', capability: 'history', variant: null },
      actionCycle: cycle(),
      facts: factsFor(),
    });
    expect(result.ok).toBe(false);
    expect(result.checks).toEqual([]);
    expect(codes(result)).toContain('HISTORY_KERNEL_ROUTE_MISMATCH');
  });

  it('rejects an Action Cycle that observed a different resolved profile', () => {
    const result = evaluateHistoryChecks({
      profile,
      route: ROUTE,
      actionCycle: { ...cycle(), resolvedProfileFingerprint: 'f'.repeat(64) },
      facts: factsFor(),
    });
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain('HISTORY_KERNEL_ACTION_CYCLE_MISMATCH');
  });

  it('rejects an Action Cycle readiness disagreement', () => {
    const result = evaluateHistoryChecks({
      profile,
      route: ROUTE,
      actionCycle: { ...cycle(), readinessFingerprint: 'e'.repeat(64) },
      facts: factsFor(),
    });
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain('HISTORY_KERNEL_READINESS_MISMATCH');
  });

  it('rejects a compiled profile whose content was mutated in place', () => {
    const mutated = tamperedProfile((clone) => {
      (clone.readiness as Record<string, unknown>).deadlineMs = 6000;
    });
    const result = run(factsFor(), mutated);
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain('HISTORY_KERNEL_PROFILE_FINGERPRINT_MISMATCH');
  });

  it('rejects a missing resolved fingerprint', () => {
    const result = run(
      factsFor(),
      tamperedProfile((clone) => {
        delete clone.resolvedFingerprint;
      }),
    );
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain('HISTORY_KERNEL_PROFILE_FINGERPRINT_MISSING');
  });

  it('rejects a non-canonical resolved fingerprint', () => {
    const result = run(
      factsFor(),
      tamperedProfile((clone) => {
        clone.resolvedFingerprint = 'not-a-fingerprint';
      }),
    );
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain('HISTORY_KERNEL_PROFILE_FINGERPRINT_INVALID');
  });

  it('rejects an invalid component fingerprint', () => {
    const result = run(
      factsFor(),
      tamperedProfile((clone) => {
        (clone.componentFingerprints as Record<string, unknown>).oracle = 'short';
      }),
    );
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain('HISTORY_KERNEL_COMPONENT_FINGERPRINT_INVALID');
  });

  it('rejects an unsupported resolved-profile schema', () => {
    const result = run(
      factsFor(),
      tamperedProfile((clone) => {
        clone.schemaVersion = 99;
      }),
    );
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain('HISTORY_KERNEL_PROFILE_SCHEMA_UNSUPPORTED');
  });

  it('rejects a non-object compiled profile', () => {
    const result = evaluateHistoryChecks({
      profile: 'not-a-profile' as unknown as ResolvedCorrectnessProfile,
      route: ROUTE,
      actionCycle: cycle(),
      facts: factsFor(),
    });
    expect(result.ok).toBe(false);
    expect(result.checks).toEqual([]);
    expect(codes(result)).toContain('HISTORY_KERNEL_PROFILE_NOT_OBJECT');
  });

  it('leaves the compiled check-set/route identity stable across recompiles', () => {
    const recompiled = compile();
    expect(recompiled.resolvedFingerprint).toBe(profile.resolvedFingerprint);
    expect(recompiled.componentFingerprints).toEqual(profile.componentFingerprints);
    expect(recompiled.requiredChecks.map((entry) => entry.checkId)).toEqual(CHECKS);
  });
});

describe('[P7-B B1-F1] required-check set and evaluator discriminants', () => {
  it('rejects an empty required-check set', () => {
    const result = run(
      factsFor(),
      tamperedProfile((clone) => {
        clone.requiredChecks = [];
      }),
    );
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain('HISTORY_KERNEL_EMPTY_REQUIRED_CHECKS');
  });

  it('rejects a declared check with no check id', () => {
    const result = run(
      factsFor(),
      tamperedProfile((clone) => {
        clone.requiredChecks = [{ evaluator: 'history-cross-subject' }];
      }),
    );
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain('HISTORY_KERNEL_REQUIRED_CHECK_MISSING');
  });

  it('rejects a duplicated declared check', () => {
    const result = run(
      factsFor(),
      tamperedProfile((clone) => {
        clone.requiredChecks = [profile.requiredChecks[0], profile.requiredChecks[0]];
      }),
    );
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain('HISTORY_KERNEL_REQUIRED_CHECK_DUPLICATE');
  });

  it('rejects an unsupported per-check evaluator discriminant', () => {
    const result = run(
      factsFor(),
      tamperedProfile((clone) => {
        clone.requiredChecks = profile.requiredChecks.map((contract) => ({
          ...contract,
          evaluator: 'canonical-delta',
        }));
      }),
    );
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain('HISTORY_KERNEL_CHECK_EVALUATOR_UNSUPPORTED');
  });

  it('rejects an unsupported Oracle evaluator discriminant', () => {
    const result = run(
      factsFor(),
      tamperedProfile((clone) => {
        (clone.oracle as Record<string, unknown>).evaluatorKind = 'frontend-restore';
      }),
    );
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain('HISTORY_KERNEL_ORACLE_EVALUATOR_UNSUPPORTED');
  });

  it('rejects facts that declare a different evaluator', () => {
    const result = run({ ...factsFor(), evaluator: 'frontend-restore' as never });
    expect(result.ok).toBe(true);
    expect(codes(result)).toContain('HISTORY_KERNEL_FACTS_EVALUATOR_MISMATCH');
  });

  it('rejects an accepted fact for an undeclared check without consuming it', () => {
    const result = run({
      ...factsFor(),
      checks: [
        ...factsFor().checks,
        {
          checkId: 'history.unknown',
          authority: 'current',
          currentness: 'current',
          sourcesAgree: true,
          mismatch: false,
        },
      ],
    });
    expect(result.ok).toBe(true);
    expect(codes(result)).toContain('HISTORY_KERNEL_FACT_CHECK_UNKNOWN');
    expect(result.checks.map((check) => check.checkId)).toEqual(CHECKS);
  });

  it('rejects a duplicated check fact', () => {
    const facts = factsFor();
    const result = run({ ...facts, checks: [...facts.checks, facts.checks[0]] });
    expect(codes(result)).toContain('HISTORY_KERNEL_FACT_CHECK_DUPLICATE');
  });

  it('rejects a legacy-shaped fact with no structured authority and makes it UNUSABLE', () => {
    const facts = factsFor();
    const result = run({
      ...facts,
      checks: facts.checks.map((check) => ({
        checkId: check.checkId,
        passed: true as never,
      })) as unknown as HistoryEvaluatorFact[],
    });
    expect(codes(result)).toContain('HISTORY_KERNEL_FACT_AUTHORITY_UNKNOWN');
    expect(result.checks.every((check) => check.status === 'UNUSABLE')).toBe(true);
  });

  it('routes exactly the delivered evaluator kind to the kernel', () => {
    expect(historyKernelKindForEvaluator('history-cross-subject')).toBe('history-cross-subject');
    for (const other of ['frontend-restore', 'crossword-determinism', 'geometry-delta', null]) {
      expect(historyKernelKindForEvaluator(other)).toBeNull();
    }
  });
});

// ── B0 pre-action baseline correlation ───────────────────────────────────────

describe('[P7-B B1-F1] B0 pre-action baseline correlation (nested pre-action authority)', () => {
  it('requires the exact H3 pre-action baseline as the head of the chain', () => {
    const result = run(factsFor());
    expect(result.checks.every((check) => check.actual.authority === 'current')).toBe(true);
    expect(checkFor(result, 'history.depth').actual.preActionBaseline).toEqual({
      pastDepth: 3,
      futureDepth: 0,
      baselineClean: false,
    });
  });

  it('is UNUSABLE for a pre-action baseline that is not the exact H3', () => {
    const evidence = evidenceFacts();
    const actions = [...evidence.actions];
    actions[0] = { ...actions[0], historyBefore: tuple(2, 1) } as HistoryActionFact;
    // The accepted Oracle does not itself validate the baseline chain, so the
    // delivered facts still claim PASS; the kernel must refuse them anyway.
    const evaluation = evaluateHistoryOracle({ ...evidence, actions });
    expect(evaluation.checks.every((check) => check.passed)).toBe(true);
    const result = run(factsFor({ ...evidence, actions }));
    expect(result.checks.every((check) => check.status === 'UNUSABLE')).toBe(true);
    expect(result.checks.every((check) => check.actual.authority === 'stale')).toBe(true);
    expect(result.checks.every((check) => check.actual.authorityScope === 'pre-action')).toBe(true);
    expect(codes(result)).toContain('HISTORY_KERNEL_PRE_ACTION_AUTHORITY_UNUSABLE');
  });

  it('is UNUSABLE for a correlated chain break at any transition', () => {
    for (const index of [1, 2, 3, 4, 5]) {
      const evidence = evidenceFacts();
      const actions = [...evidence.actions];
      actions[index] = {
        ...actions[index],
        historyBefore: tuple(3, 0),
      } as HistoryActionFact;
      const evaluation = evaluateHistoryOracle({ ...evidence, actions });
      expect(evaluation.checks.every((check) => check.passed)).toBe(true);
      const result = run(factsFor({ ...evidence, actions }));
      expect(result.checks.every((check) => check.status === 'UNUSABLE')).toBe(true);
      expect(result.checks.every((check) => check.actual.authority === 'stale')).toBe(true);
    }
  });

  it('is UNUSABLE for a non-product-exact baselineClean anywhere in the chain', () => {
    const evidence = evidenceFacts();
    const actions = [...evidence.actions];
    actions[3] = {
      ...actions[3],
      historyBefore: { pastDepth: 2, futureDepth: 1, baselineClean: true },
    } as HistoryActionFact;
    const result = run(factsFor({ ...evidence, actions }));
    expect(result.checks.every((check) => check.status === 'UNUSABLE')).toBe(true);
    expect(result.checks.every((check) => check.actual.authority === 'malformed')).toBe(true);
  });

  it('is UNUSABLE when a required pre-action revision is absent', () => {
    const evidence = evidenceFacts();
    const actions = [...evidence.actions];
    actions[2] = {
      ...actions[2],
      preActionRevision: null as unknown as number,
    } as HistoryActionFact;
    const result = run(factsFor({ ...evidence, actions }));
    expect(result.checks.every((check) => check.status === 'UNUSABLE')).toBe(true);
    expect(result.checks.every((check) => check.actual.authority === 'malformed')).toBe(true);
  });

  it('keeps the pre-action authority independent of the delivered boolean facts', () => {
    const evidence = evidenceFacts();
    const actions = [...evidence.actions];
    actions[4] = {
      ...actions[4],
      historyBefore: { pastDepth: 9, futureDepth: 9, baselineClean: false },
    } as HistoryActionFact;
    const facts = factsFor({ ...evidence, actions });
    expect(evaluateHistoryOracle(evidence).checks.every((check) => check.passed)).toBe(true);
    const result = run(facts);
    for (const check of result.checks) {
      expect(check.status).toBe('UNUSABLE');
      expect(check.actual.preActionBaseline).toEqual({
        pastDepth: 3,
        futureDepth: 0,
        baselineClean: false,
      });
    }
  });

  it('preserves the accepted B0 nested pre-action typed-authority request correlation', () => {
    // ADR 0027 section 3.2 B-R2: the nested-object pre-action member is the
    // closed `pre-action`/`authorize-native-action` pair, and any other
    // phase/purpose combination fails closed before correlation.
    const base = {
      schemaVersion: NESTED_OBJECT_REQUEST_SCHEMA_VERSION,
      representation: NESTED_OBJECT_AFFINE_CHAIN_KIND,
      targetId: 'object-outer',
      witnessId: 'text-witness',
      layoutId: 'layout-object-active',
    };
    expect(
      validateNestedObjectRequestV3({
        ...base,
        interaction: { phase: 'pre-action', purpose: 'authorize-native-action' },
      }).ok,
    ).toBe(true);
    expect(
      validateNestedObjectRequestV3({
        ...base,
        interaction: { phase: 'post-action', purpose: 'observe-authoritative-geometry' },
      }).ok,
    ).toBe(true);
    for (const interaction of [
      { phase: 'pre-action', purpose: 'observe-authoritative-geometry' },
      { phase: 'post-action', purpose: 'authorize-native-action' },
      { phase: 'pre-action' },
      {},
    ]) {
      expect(validateNestedObjectRequestV3({ ...base, interaction }).ok).toBe(false);
    }
  });
});

// ── Compiled single-leaf mutation matrix ─────────────────────────────────────

describe('[P7-B B1-F1] relevant compiled-field mutation matrix', () => {
  function collectLeafPaths(value: unknown, prefix: string, out: string[]): void {
    if (Array.isArray(value)) {
      value.forEach((entry, index) => {
        collectLeafPaths(entry, prefix === '' ? `[${index}]` : `${prefix}[${index}]`, out);
      });
      return;
    }
    if (value !== null && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) {
        collectLeafPaths(child, prefix === '' ? key : `${prefix}.${key}`, out);
      }
      return;
    }
    out.push(prefix);
  }

  function mutateLeaf(root: Record<string, unknown>, leafPath: string): void {
    const parts = leafPath.replace(/\[(\d+)\]/g, '.$1').split('.');
    let node: unknown = root;
    for (let index = 0; index < parts.length - 1; index += 1) {
      node = (node as Record<string, unknown>)[parts[index] as string];
    }
    const leaf = (node as Record<string, unknown>)[parts[parts.length - 1] as string];
    let replacement: unknown = 'mutated';
    if (typeof leaf === 'string') replacement = `${leaf}-mutated`;
    else if (typeof leaf === 'number') replacement = leaf + 1;
    else if (typeof leaf === 'boolean') replacement = !leaf;
    (node as Record<string, unknown>)[parts[parts.length - 1] as string] = replacement;
  }

  const leafPaths: string[] = [];
  collectLeafPaths(profile, '', leafPaths);

  it('covers the complete compiled cross-subject History profile projection', () => {
    expect(leafPaths.length).toBeGreaterThanOrEqual(150);
  });

  it('compiles to the exact runtime resolved fingerprint', () => {
    // The planner compiles the same route with the same declared checks, so the
    // kernel consumes the exact runtime profile identity.
    expect(profile.resolvedFingerprint).toBe(
      '63ace6473ff0a606e06a5e992c5265d30f9574be5108327a7fb3e063b940b2ab',
    );
  });

  it('rejects every single-leaf mutation of the compiled History profile', () => {
    const baseFacts = factsFor();
    for (const leafPath of leafPaths) {
      const clone = structuredClone(profile) as unknown as Record<string, unknown>;
      mutateLeaf(clone, leafPath);
      const mutated = clone as unknown as ResolvedCorrectnessProfile;
      const result = evaluateHistoryChecks({
        profile: mutated,
        route: ROUTE,
        actionCycle: cycle(mutated),
        facts: baseFacts,
      });
      expect(result.ok, `mutation of ${leafPath} was not detected`).toBe(false);
    }
  });

  it('detects an in-place compiled identity mutation through the fingerprint derivation', () => {
    const clone = structuredClone(profile) as unknown as Record<string, unknown>;
    (clone.readiness as Record<string, unknown>).deadlineMs = 4999;
    const derived = deriveResolvedCorrectnessProfileFingerprint(
      clone as unknown as Omit<ResolvedCorrectnessProfile, 'resolvedFingerprint'>,
    );
    expect(derived).not.toBe(profile.resolvedFingerprint);
  });
});

// ── Inactive kernel invariants ───────────────────────────────────────────────

describe('[P7-B B1-F1] inactive kernel invariants', () => {
  const skillRoot = path.resolve(process.cwd(), '.pi/skills/verify-artwork-editor');
  const source = (relative: string): string => readFileSync(path.join(skillRoot, relative), 'utf8');

  it('does not import any active executor, Oracle, readiness loop, evidence writer, or classifier', () => {
    const kernel = source('src/kernels/history-kernel.ts');
    expect(kernel).not.toMatch(/from '\.\.\/(runtime|oracles|readiness|evidence)\//);
    expect(kernel).not.toContain('execute-plan');
    expect(kernel).not.toContain('execute-history-plan');
    expect(kernel).not.toContain('contracts/execution');
    expect(kernel).not.toMatch(/from '\.\.\/runtime\/outcomes'/);
    expect(kernel).not.toMatch(/from '\.\.\/runtime\/result-outcome'/);
    expect(kernel).not.toContain("from '../oracles/history'");
    expect(kernel).not.toContain('public-dto');
  });

  it('owns no required-check list, check id, Subject branch, or catalogue reload', () => {
    const kernel = source('src/kernels/history-kernel.ts');
    for (const literal of [
      "'history.depth'",
      "'history.meaning'",
      "'artwork/editor'",
      "'layer/text'",
    ]) {
      expect(kernel).not.toContain(literal);
    }
    expect(kernel).not.toContain('loadCorrectnessCatalogue');
    expect(kernel).not.toContain('fallbackId');
  });

  it('is not referenced by any active executor, Oracle, or writer module', () => {
    for (const relative of [
      'src/runtime/execute-plan.ts',
      'src/runtime/execute-history-plan.ts',
      'src/runtime/action-cycle.ts',
      'src/oracles/evaluate.ts',
      'src/oracles/history.ts',
      'src/evidence/writer.ts',
      'src/evidence/public-dto.ts',
      'src/runtime/outcomes.ts',
    ]) {
      expect(source(relative)).not.toContain('history-kernel');
      expect(source(relative)).not.toContain('evaluateHistoryChecks');
    }
  });

  it('leaves the active boolean CheckResult and v3 record schema unchanged', () => {
    expect(source('src/contracts/execution.ts')).toMatch(
      /export interface CheckResult \{\n {2}checkId: string;\n {2}passed: boolean;\n\}/,
    );
    expect(source('src/contracts/schema-versions.ts')).toContain(
      'export const DIAGNOSTIC_RUN_RECORD_SCHEMA_VERSION = 3;',
    );
  });

  it('keeps every produced component fingerprint full canonical', () => {
    const result = run(factsFor());
    for (const check of result.checks) {
      expect(isFullCanonicalFingerprint(check.consumedComponentFingerprints.resolvedProfile)).toBe(
        true,
      );
      expect(isFullCanonicalFingerprint(check.consumedComponentFingerprints.oracle)).toBe(true);
      expect(isFullCanonicalFingerprint(check.consumedComponentFingerprints.capture)).toBe(true);
      expect(Object.hasOwn(check.consumedComponentFingerprints, 'readiness')).toBe(false);
      expect(isFullCanonicalFingerprint(check.consumedComponentFingerprints.requiredCheckSet)).toBe(
        true,
      );
    }
    expect(isFullCanonicalFingerprint(profile.componentFingerprints.readiness)).toBe(true);
  });
});
