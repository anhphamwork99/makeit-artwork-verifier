/**
 * WP5 Slice 5-F — history runtime contract tests (ADR 0019 R4/R10; ADR 0021 N7).
 *
 * Pure tests for the cross-subject history drive's declarative wiring: the
 * closed workflow-shape discriminant, the registered readiness/Oracle profiles,
 * the delivered default adapter, and the two-check history Oracle evaluation.
 */

import { describe, expect, it } from 'vitest';

import { resolveAdapterImplementation } from '../../src/adapters/registry';
import { loadCatalogueBundle } from '../../src/catalogue/load';
import {
  HISTORY_ACTION_STEPS,
  HISTORY_REQUIRED_CHECKS,
  HISTORY_SETUP_CHECKPOINTS,
  HISTORY_TRANSITION_PROFILE_ID,
} from '../../src/contracts/history-observation';
import { resolveExecutionSupport } from '../../src/planner/execution-support';
import { resolveReadinessProfile } from '../../src/readiness/profile-registry';
import { resolveOracleProfile } from '../../src/oracles/profile-registry';
import {
  HISTORY_ORACLE_PROFILE_ID,
  evaluateHistoryOracle,
  type HistoryActionFact,
  type HistoryEvidenceFacts,
  type HistoryTupleView,
} from '../../src/oracles/history';
import { historyWorkflowMatches } from '../../src/runtime/execute-history-plan';
import { resolveWorkflowSteps } from '../../src/workflows/steps';

function tuple(pastDepth: number, futureDepth: number): HistoryTupleView {
  return { pastDepth, futureDepth, baselineClean: pastDepth === 0 && futureDepth === 0 };
}

function validFacts(): HistoryEvidenceFacts {
  return {
    retainedLayoutId: 'layout-a',
    setup: HISTORY_SETUP_CHECKPOINTS.map((checkpoint) => ({
      checkpointId: checkpoint.checkpointId,
      role: checkpoint.role,
      meaning: checkpoint.meaning,
      pastDepth: checkpoint.pastDepth,
      futureDepth: checkpoint.futureDepth,
      baselineClean: checkpoint.pastDepth === 0,
      meaningFingerprint: `fp-${checkpoint.meaning}`,
    })),
    actions: HISTORY_ACTION_STEPS.map<HistoryActionFact>((step, index) => ({
      stepIndex: step.stepIndex,
      stepId: step.stepId,
      control: step.control,
      controlAccessibleName: step.control === 'undo' ? 'Undo (⌘Z)' : 'Redo (⌘⇧Z)',
      controlTitle: step.control === 'undo' ? 'Undo (⌘Z)' : 'Redo (⌘⇧Z)',
      controlNativeTag: 'BUTTON',
      controlButtonType: 'button',
      controlVisible: true,
      controlEnabledBeforeDispatch: true,
      dispatchCount: 1,
      preActionRevision: 10 + step.stepIndex,
      postActionRevision: 11 + step.stepIndex,
      historyBefore:
        index === 0
          ? tuple(3, 0)
          : { ...(HISTORY_ACTION_STEPS[index - 1]?.expectedHistory ?? step.expectedHistory) },
      historyAfter: { ...step.expectedHistory },
      expectedHistory: { ...step.expectedHistory },
      historyTupleExact: true,
      expectedMeaning: step.expectedMeaning,
      meaningFingerprint: `mean-${step.expectedMeaning}`,
      expectedMeaningFingerprint: `mean-${step.expectedMeaning}`,
      meaningStructurallyEqual: true,
      observationId: `obs-${step.stepIndex}`,
      idle: { stableFrames: 3, waitedMs: 0, observationRevision: 11 + step.stepIndex },
      tornRecaptureCount: 0,
      transitionObserved: true,
    })),
    finalHistory: { pastDepth: 3, futureDepth: 0, baselineClean: false },
  };
}

describe('[WP5 Slice 5-F] history drive declarative wiring', () => {
  it('selects the history drive only for the exact six-transition workflow shape', () => {
    const bundle = loadCatalogueBundle();
    const history = resolveWorkflowSteps(bundle.workflowStepCatalogue, 'shared.history');
    const move = resolveWorkflowSteps(bundle.workflowStepCatalogue, 'shared.move');
    expect(history).not.toBeNull();
    expect(move).not.toBeNull();
    expect(historyWorkflowMatches(history?.steps ?? [])).toBe(true);
    expect(historyWorkflowMatches(move?.steps ?? [])).toBe(false);
    expect(historyWorkflowMatches([])).toBe(false);
  });

  it('registers the exact history readiness and Oracle profiles', () => {
    const readiness = resolveReadinessProfile(HISTORY_TRANSITION_PROFILE_ID);
    expect(readiness).not.toBeNull();
    expect(readiness?.oracleProfileId).toBe(HISTORY_ORACLE_PROFILE_ID);
    expect(readiness?.profile.timingCategory).toBe('INTERACTIVE_HISTORY_V1');
    expect(readiness?.profile.deadlineMs).toBe(5000);
    expect(readiness?.profile.stableFrames).toBe(3);
    expect(readiness?.requiresNestedPair).toBe(false);
    expect(readiness?.requiresCrosswordSet).toBeUndefined();

    const oracle = resolveOracleProfile(HISTORY_ORACLE_PROFILE_ID);
    expect(oracle).not.toBeNull();
    expect(oracle?.kind).toBe('history-cross-subject');
  });

  it('delivers the default adapter and marks its execution supported', () => {
    const bundle = loadCatalogueBundle();
    const declaration = { adapterId: 'default', compatibilityVersion: 1 };
    const resolved = resolveAdapterImplementation({
      catalogue: bundle.adapterCatalogue,
      declaration,
    });
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.adapter.adapterId).toBe('default');
      expect(resolved.adapter.compatibilityVersion).toBe(1);
    }
    expect(resolveExecutionSupport('default', 'shared.history').supported).toBe(true);
    expect(resolveExecutionSupport('default', 'shared.move').supported).toBe(false);
    expect(resolveExecutionSupport('default').supported).toBe(false);
  });
});

describe('[WP5 Slice 5-F] history Oracle', () => {
  it('passes the exact four-checkpoint/six-transition evidence', () => {
    const evaluation = evaluateHistoryOracle(validFacts(), HISTORY_REQUIRED_CHECKS);
    expect(evaluation.harnessInvalid).toBe(false);
    expect(evaluation.passed).toBe(true);
    expect(evaluation.checks).toEqual([
      { checkId: 'history.depth', passed: true },
      { checkId: 'history.meaning', passed: true },
    ]);
  });

  it('fails the depth check (not harness-invalid) for a safely dispatched wrong tuple', () => {
    const facts = validFacts();
    const actions = facts.actions as HistoryActionFact[];
    actions[2] = {
      ...actions[2],
      historyAfter: tuple(1, 2),
      historyTupleExact: false,
    } as HistoryActionFact;
    const evaluation = evaluateHistoryOracle(facts, HISTORY_REQUIRED_CHECKS);
    expect(evaluation.harnessInvalid).toBe(false);
    expect(evaluation.passed).toBe(false);
    expect(evaluation.checks.find((check) => check.checkId === 'history.depth')?.passed).toBe(
      false,
    );
    expect(evaluation.checks.find((check) => check.checkId === 'history.meaning')?.passed).toBe(
      true,
    );
  });

  it('fails the meaning check (not harness-invalid) for a wrong restored meaning', () => {
    const facts = validFacts();
    const actions = facts.actions as HistoryActionFact[];
    actions[4] = {
      ...actions[4],
      meaningStructurallyEqual: false,
      meaningFingerprint: 'other',
    } as HistoryActionFact;
    const evaluation = evaluateHistoryOracle(facts, HISTORY_REQUIRED_CHECKS);
    expect(evaluation.harnessInvalid).toBe(false);
    expect(evaluation.passed).toBe(false);
    expect(evaluation.checks.find((check) => check.checkId === 'history.meaning')?.passed).toBe(
      false,
    );
  });

  it('is harness-invalid for a wrong setup shape or a wrong step count', () => {
    const wrongSetup = validFacts();
    (wrongSetup.setup as unknown as HistoryEvidenceFacts['setup'][number][])[1] = {
      ...wrongSetup.setup[1],
      pastDepth: 2,
    } as HistoryEvidenceFacts['setup'][number];
    expect(evaluateHistoryOracle(wrongSetup, HISTORY_REQUIRED_CHECKS).harnessInvalid).toBe(true);

    const wrongCount = validFacts();
    (wrongCount as unknown as { actions: HistoryActionFact[] }).actions = wrongCount.actions.slice(
      0,
      5,
    );
    expect(evaluateHistoryOracle(wrongCount, HISTORY_REQUIRED_CHECKS).harnessInvalid).toBe(true);
  });

  it('declares all six action expectations product-exact baselineClean=false', () => {
    expect(HISTORY_ACTION_STEPS.map((step) => step.expectedHistory.baselineClean)).toEqual([
      false,
      false,
      false,
      false,
      false,
      false,
    ]);
  });

  it('fails the depth check for a hardcoded non-product-exact expected baselineClean', () => {
    const facts = validFacts();
    const actions = facts.actions as HistoryActionFact[];
    // Depth still matches and `historyTupleExact` is (dishonestly) true, but the
    // expected `baselineClean` contradicts the tuple's own positional fact.
    actions[0] = {
      ...actions[0],
      expectedHistory: { pastDepth: 2, futureDepth: 1, baselineClean: true },
    } as HistoryActionFact;
    const evaluation = evaluateHistoryOracle(facts, HISTORY_REQUIRED_CHECKS);
    expect(evaluation.harnessInvalid).toBe(false);
    expect(evaluation.passed).toBe(false);
    expect(evaluation.checks.find((check) => check.checkId === 'history.depth')?.passed).toBe(
      false,
    );
  });

  it('fails the depth check when the observed baselineClean contradicts its tuple', () => {
    const facts = validFacts();
    const actions = facts.actions as HistoryActionFact[];
    actions[3] = {
      ...actions[3],
      historyAfter: { pastDepth: 1, futureDepth: 2, baselineClean: true },
    } as HistoryActionFact;
    const evaluation = evaluateHistoryOracle(facts, HISTORY_REQUIRED_CHECKS);
    expect(evaluation.harnessInvalid).toBe(false);
    expect(evaluation.checks.find((check) => check.checkId === 'history.depth')?.passed).toBe(
      false,
    );
  });

  it('fails the depth check when the final H3 baselineClean is not false', () => {
    const facts = validFacts();
    (facts as { finalHistory: HistoryTupleView }).finalHistory = {
      pastDepth: 3,
      futureDepth: 0,
      baselineClean: true,
    };
    const evaluation = evaluateHistoryOracle(facts, HISTORY_REQUIRED_CHECKS);
    expect(evaluation.harnessInvalid).toBe(false);
    expect(evaluation.checks.find((check) => check.checkId === 'history.depth')?.passed).toBe(
      false,
    );
  });
});
