import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadCatalogueBundle, type CatalogueBundle } from '../../src/catalogue/load';
import { loadDiagnosticSuite, resolveSuiteRequests } from '../../src/catalogue/suite';
import {
  HISTORY_ACTION_STEPS,
  HISTORY_CONTROLS,
  HISTORY_CONTROL_BUTTON_TYPE,
  HISTORY_CONTROL_NATIVE_TAG,
  HISTORY_REQUIRED_CHECKS,
  HISTORY_SETUP_CHECKPOINTS,
  productBaselineClean,
} from '../../src/contracts/history-observation';
import { CHECK_RESULT_CONTRACT_SCHEMA_VERSION } from '../../src/contracts/schema-versions';
import {
  HISTORY_LIVE_FACT_ISSUE_CODES,
  adaptHistoryLiveFacts,
  evaluateHistoryLiveChecks,
  projectHistoryLiveFacts,
  type HistoryLiveEvaluationObservation,
  type HistoryLiveFactFailure,
  type HistoryLiveFactRoute,
} from '../../src/adapters/history-live-facts';
import {
  isFullCanonicalFingerprint,
  projectCorrectnessProfileIdentity,
  validateResultIdentityAgreement,
} from '../../src/index';
import { evaluateHistoryOracle } from '../../src/oracles/history';
import type {
  HistoryActionFact,
  HistoryEvidenceFacts,
  HistorySetupFact,
} from '../../src/oracles/history';
import {
  MATERIALIZED_EXECUTION_ENVELOPE_SCHEMA_VERSION,
  type MaterializedExecutionEnvelopeV1,
} from '../../src/planner/execution-materialization';
import { planCaseForExecution } from '../../src/planner/plan-case';
import { resolveToolkitRoot } from '../../src/runtime/paths';
import type {
  ActionCycleCorrectnessIdentity,
  CorrectnessCheckResult,
  HistoryEvidenceAvailability,
  HistoryEvidenceFact,
  HistoryKernelFacts,
} from '../../src/index';

/**
 * P7-B2-B5 focused proof: inactive live-fact adapter for cross-subject History
 * (ADR 0029 §4 B2-B, the History half).
 *
 * The suites drive the adapter from the *real* exact envelope produced by
 * `planCaseForExecution` for the representative cross-subject History request
 * and the *real* accepted `evaluateHistoryOracle` outputs over the accepted
 * whole-document six-transition chain. They cover PASS, a trustworthy depth
 * mismatch, a trustworthy meaning mismatch, missing/stale/torn/wrong-target/
 * malformed/ambiguous chain authority, evidence identity/agreement, fail-closed
 * envelope rejection before the kernel, no adapter policy, no active imports,
 * no legacy boolean/harnessInvalid authority in the produced structured facts
 * (legacy flips have no effect; primitive flips have effect), and a
 * single-leaf mutation of every compiled compatibility field.
 */

const skillRoot = resolveToolkitRoot();
const bundle: CatalogueBundle = loadCatalogueBundle();

function representativeRequest(fileName: string): unknown {
  const resolved = resolveSuiteRequests(loadDiagnosticSuite('representative'));
  const entry = resolved.find((candidate) => path.basename(candidate.relativePath) === fileName);
  if (entry === undefined) throw new Error(`missing representative request ${fileName}`);
  return entry.request;
}

const HISTORY_REQUEST = 'artwork-editor-history-undo-redo.json';

interface PreparedCase {
  readonly envelope: MaterializedExecutionEnvelopeV1;
  readonly route: HistoryLiveFactRoute;
}

function prepare(fileName: string): PreparedCase {
  const result = planCaseForExecution(representativeRequest(fileName), { catalogues: bundle });
  if (result.status !== 'PLANNED') throw new Error(`${fileName} did not plan: ${result.status}`);
  if (result.envelope === null) throw new Error(`${fileName} produced no envelope`);
  const envelope = result.envelope;
  const intent = result.materializedCase.intent;
  expect(envelope.schemaVersion).toBe(MATERIALIZED_EXECUTION_ENVELOPE_SCHEMA_VERSION);
  return {
    envelope,
    route: {
      subjectId: intent.subjectId,
      capability: intent.capability,
      variant: intent.variant,
    },
  };
}

const historyCase = prepare(HISTORY_REQUEST);
const profile = historyCase.envelope.correctnessProfile;

function cycle(actionCycleId: string): ActionCycleCorrectnessIdentity {
  return {
    schemaVersion: CHECK_RESULT_CONTRACT_SCHEMA_VERSION,
    actionCycleId,
    resolvedProfileFingerprint: profile.resolvedFingerprint,
    readinessFingerprint: profile.componentFingerprints.readiness,
  };
}

const HISTORY_CYCLE = cycle('b2b5-cycle-history');

function evidenceAll(
  overrides: Readonly<Record<string, HistoryEvidenceAvailability>> = {},
): HistoryEvidenceFact[] {
  return profile.requiredAuthoritativeEvidence.map((evidenceId) => ({
    evidenceId,
    availability: overrides[evidenceId] ?? 'authoritative',
  }));
}

// ── Real accepted whole-document chain fixtures (WP5 Slice 5-F) ──────────────

function tuple(
  pastDepth: number,
  futureDepth: number,
): {
  pastDepth: number;
  futureDepth: number;
  baselineClean: boolean;
} {
  return {
    pastDepth,
    futureDepth,
    baselineClean: productBaselineClean(pastDepth, futureDepth),
  };
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
function beforeFor(index: number): {
  pastDepth: number;
  futureDepth: number;
  baselineClean: boolean;
} {
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

function chainFacts(overrides: Partial<HistoryEvidenceFacts> = {}): HistoryEvidenceFacts {
  return {
    retainedLayoutId: 'layout-a',
    setup: setupFacts(),
    actions: actionFacts(),
    finalHistory: tuple(3, 0),
    ...overrides,
  };
}

function readinessFacts(): Record<string, unknown> {
  return {
    policy: {
      profileId: profile.readiness.profileId,
      deadlineCategory: profile.readiness.deadlineCategory,
      deadlineMs: profile.readiness.deadlineMs,
      signalWatchdogMs: profile.readiness.signalWatchdogMs,
      fallbackCadenceMs: [...profile.readiness.fallbackCadenceMs],
      stableFrames: profile.readiness.stableFrames,
      quiescenceRequired: profile.readiness.quiescenceRequired,
      stableFrameRequired: profile.readiness.stableFrameRequired,
    },
    observation: {
      outcome: 'signal',
      wakeSource: 'store-signal',
      fallbackPollCount: 0,
      watchdogWaits: 0,
      observedStableFrames: profile.readiness.stableFrames,
      detail: null,
    },
  };
}

const PASS_CHAIN = chainFacts();

// ── Adapter invocation helpers ───────────────────────────────────────────────

function observationOf(facts: HistoryEvidenceFacts): HistoryLiveEvaluationObservation {
  const evaluation = evaluateHistoryOracle(facts);
  return {
    primitiveFacts: evaluation.primitiveFacts,
    diagnostics: evaluation.diagnostics,
  };
}

type AdapterInput = Parameters<typeof adaptHistoryLiveFacts>[0];

function historyInput(
  facts: HistoryEvidenceFacts,
  overrides: Partial<AdapterInput> = {},
): AdapterInput {
  return {
    envelope: historyCase.envelope,
    route: historyCase.route,
    actionCycle: HISTORY_CYCLE,
    retainedLayoutId: facts.retainedLayoutId,
    setup: facts.setup,
    actions: facts.actions,
    finalHistory: facts.finalHistory,
    readiness: readinessFacts(),
    oracle: observationOf(facts),
    evidence: evidenceAll(),
    ...overrides,
  };
}

function issueCodes(failure: HistoryLiveFactFailure): string[] {
  return failure.issues.map((issue) => issue.code);
}

function assertIdentityAgreement(
  checks: readonly CorrectnessCheckResult[],
  aCycle: ActionCycleCorrectnessIdentity,
): void {
  const identity = projectCorrectnessProfileIdentity(profile);
  const validation = validateResultIdentityAgreement(identity, {
    actionCycles: [aCycle],
    requiredChecks: checks,
  });
  expect(validation.ok).toBe(true);
  expect(validation.issues).toEqual([]);
  for (const check of checks) {
    expect(check.actionCycleRef).toBe(aCycle.actionCycleId);
    expect(check.consumedComponentFingerprints.resolvedProfile).toBe(profile.resolvedFingerprint);
    expect(check.consumedComponentFingerprints.oracle).toBe(profile.componentFingerprints.oracle);
    expect(check.consumedComponentFingerprints.capture).toBe(profile.componentFingerprints.capture);
  }
}

function statusFor(checks: readonly CorrectnessCheckResult[], checkId: string): string | undefined {
  return checks.find((check) => check.checkId === checkId)?.status;
}

function checkFor(
  checks: readonly CorrectnessCheckResult[],
  checkId: string,
): CorrectnessCheckResult | undefined {
  return checks.find((check) => check.checkId === checkId);
}

function diagnosticCodesOf(check: CorrectnessCheckResult | undefined): string[] {
  const codes = check?.actual.diagnosticCodes;
  return Array.isArray(codes)
    ? codes.filter((code): code is string => typeof code === 'string')
    : [];
}

function oracleViewOf(check: CorrectnessCheckResult): Record<string, unknown> {
  const oracle = check.actual.oracle;
  return oracle !== null && typeof oracle === 'object' ? (oracle as Record<string, unknown>) : {};
}

const CHECK_IDS = ['history.depth', 'history.meaning'];

const EVIDENCE_BY_CHECK: Readonly<Record<string, string[]>> = Object.fromEntries(
  profile.requiredChecks.map((contract) => [
    contract.checkId,
    [...contract.requiredEvidence].sort(),
  ]),
);

// ── Envelope agreement and fail-closed adaptation ───────────────────────────

describe('[P7-B2-B5] exact-envelope agreement and fail-closed adaptation', () => {
  it('adapts the real representative History envelope into complete structured facts', () => {
    const adaptation = adaptHistoryLiveFacts(historyInput(PASS_CHAIN));
    expect(adaptation.ok).toBe(true);
    if (!adaptation.ok) return;
    expect(adaptation.facts.evaluator).toBe('history-cross-subject');
    expect(adaptation.facts.checks.map((entry) => entry.checkId).sort()).toEqual(
      [...CHECK_IDS].sort(),
    );
    for (const entry of adaptation.facts.checks) {
      expect(entry.authority).toBe('current');
      expect(entry.currentness).toBe('current');
      expect(entry.mismatch).toBe(false);
      expect(entry.sourcesAgree).toBe(true);
      expect(Object.hasOwn(entry, 'passed')).toBe(false);
      expect(Object.hasOwn(entry, 'unusable')).toBe(false);
    }
    const oracleFacts = adaptation.facts.oracleFacts;
    expect(oracleFacts).not.toBeNull();
    expect(oracleFacts?.authority).toBe('current');
    expect(oracleFacts?.chainAgreement).toBe(true);
    expect(oracleFacts?.retainedLayoutId).toBe('layout-a');
    expect(oracleFacts?.setup).toHaveLength(HISTORY_SETUP_CHECKPOINTS.length);
    expect(oracleFacts?.transitions).toHaveLength(HISTORY_ACTION_STEPS.length);
    expect(oracleFacts?.finalHistory).toEqual({
      pastDepth: 3,
      futureDepth: 0,
      baselineClean: false,
    });
    expect(oracleFacts?.checks.map((check) => check.checkId).sort()).toEqual([...CHECK_IDS].sort());
    expect(Object.hasOwn(adaptation.facts, 'harnessInvalid')).toBe(false);
    expect(adaptation.facts.setup).toBe(PASS_CHAIN.setup);
    expect(adaptation.facts.actions).toBe(PASS_CHAIN.actions);
    expect(adaptation.facts.finalHistory).toBe(PASS_CHAIN.finalHistory);
  });

  it('fails closed before the kernel on every envelope disagreement class', () => {
    const planFingerprint = adaptHistoryLiveFacts({
      ...historyInput(PASS_CHAIN),
      envelope: {
        ...historyCase.envelope,
        planFingerprint: 'f'.repeat(64),
      } as MaterializedExecutionEnvelopeV1,
    });
    expect(planFingerprint.ok).toBe(false);
    if (!planFingerprint.ok) {
      expect(planFingerprint.status).toBe('HARNESS_BLOCKED');
      expect(planFingerprint.launchAttempted).toBe(false);
      expect(issueCodes(planFingerprint)).toContain('ENVELOPE_PLAN_FINGERPRINT_MISMATCH');
    }

    const caseId = adaptHistoryLiveFacts({
      ...historyInput(PASS_CHAIN),
      envelope: {
        ...historyCase.envelope,
        caseId: 'other-case',
      } as MaterializedExecutionEnvelopeV1,
    });
    expect(caseId.ok).toBe(false);

    const routeMismatch = adaptHistoryLiveFacts({
      ...historyInput(PASS_CHAIN),
      route: { ...historyCase.route, variant: 'foreign-variant' },
    });
    expect(routeMismatch.ok).toBe(false);
    if (!routeMismatch.ok) {
      expect(issueCodes(routeMismatch)).toContain('ENVELOPE_ROUTE_MISMATCH');
    }

    const evaluatorMismatch = adaptHistoryLiveFacts({
      ...historyInput(PASS_CHAIN),
      envelope: {
        ...historyCase.envelope,
        correctnessProfile: {
          ...profile,
          oracle: { ...profile.oracle, evaluatorKind: 'geometry-delta' },
        },
      } as unknown as MaterializedExecutionEnvelopeV1,
    });
    expect(evaluatorMismatch.ok).toBe(false);
    if (!evaluatorMismatch.ok) {
      expect(issueCodes(evaluatorMismatch)).toContain('ENVELOPE_ORACLE_EVALUATOR_UNSUPPORTED');
    }

    const actionCycleMismatch = adaptHistoryLiveFacts({
      ...historyInput(PASS_CHAIN),
      actionCycle: { ...HISTORY_CYCLE, resolvedProfileFingerprint: 'a'.repeat(64) },
    });
    expect(actionCycleMismatch.ok).toBe(false);
    if (!actionCycleMismatch.ok) {
      expect(issueCodes(actionCycleMismatch)).toContain('ENVELOPE_ACTION_CYCLE_MISMATCH');
    }

    const readinessMismatch = adaptHistoryLiveFacts({
      ...historyInput(PASS_CHAIN),
      actionCycle: { ...HISTORY_CYCLE, readinessFingerprint: 'b'.repeat(64) },
    });
    expect(readinessMismatch.ok).toBe(false);
    if (!readinessMismatch.ok) {
      expect(issueCodes(readinessMismatch)).toContain('ENVELOPE_READINESS_MISMATCH');
    }

    const invalidEvidence = adaptHistoryLiveFacts({
      ...historyInput(PASS_CHAIN),
      evidence: [{ evidenceId: 'observation', availability: 'invented' } as never],
    });
    expect(invalidEvidence.ok).toBe(false);
    if (!invalidEvidence.ok) {
      expect(issueCodes(invalidEvidence)).toContain('HISTORY_LIVE_EVIDENCE_FACT_INVALID');
    }

    const malformedObservation = adaptHistoryLiveFacts({
      ...historyInput(PASS_CHAIN),
      oracle: {
        primitiveFacts: { authority: 'current' },
      } as unknown as HistoryLiveEvaluationObservation,
    });
    expect(malformedObservation.ok).toBe(false);
    if (!malformedObservation.ok) {
      expect(issueCodes(malformedObservation)).toContain('HISTORY_LIVE_OBSERVATION_MALFORMED');
    }

    const unknownIssueCodes = new Set<string>(HISTORY_LIVE_FACT_ISSUE_CODES);
    for (const failure of [planFingerprint, routeMismatch, actionCycleMismatch, invalidEvidence]) {
      if (failure.ok) continue;
      for (const issue of failure.issues) {
        expect(unknownIssueCodes.has(issue.code)).toBe(true);
      }
    }
  });

  it('never invokes the kernel on a disagreeing envelope', () => {
    const failed = evaluateHistoryLiveChecks({
      ...historyInput(PASS_CHAIN),
      actionCycle: { ...HISTORY_CYCLE, resolvedProfileFingerprint: 'c'.repeat(64) },
    });
    expect(failed.ok).toBe(false);
    expect(Object.hasOwn(failed, 'result')).toBe(false);
    expect(Object.hasOwn(failed, 'facts')).toBe(false);
  });
});

// ── History live-fact behavior ──────────────────────────────────────────────

describe('[P7-B2-B5] History live facts', () => {
  it('produces complete PASS checks with identity/evidence agreement', () => {
    const outcome = evaluateHistoryLiveChecks(historyInput(PASS_CHAIN));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.checks.map((check) => check.checkId).sort()).toEqual(
      [...CHECK_IDS].sort(),
    );
    for (const check of outcome.result.checks) {
      expect(check.status).toBe('PASS');
      expect(check.actual.authority).toBe('current');
      expect(check.actual.authorityScope).toBeNull();
      expect(check.evidenceIds).toEqual(EVIDENCE_BY_CHECK[check.checkId]);
    }
    assertIdentityAgreement(outcome.result.checks, HISTORY_CYCLE);
  });

  it('fails only history.depth for a coherent wrong final transition tuple', () => {
    const facts = chainFacts();
    const actions = [...facts.actions];
    actions[5] = { ...actions[5], historyAfter: tuple(2, 1) } as HistoryActionFact;
    const evidence = { ...facts, actions, finalHistory: tuple(2, 1) };
    const evaluation = evaluateHistoryOracle(evidence);
    expect(evaluation.harnessInvalid).toBe(false);
    expect(evaluation.primitiveFacts.preActionChainCorrelates).toBe(true);

    const outcome = evaluateHistoryLiveChecks(historyInput(evidence));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(statusFor(outcome.result.checks, 'history.depth')).toBe('FAIL');
    expect(statusFor(outcome.result.checks, 'history.meaning')).toBe('PASS');
    expect(checkFor(outcome.result.checks, 'history.depth')?.actual.authority).toBe('current');
    expect(diagnosticCodesOf(checkFor(outcome.result.checks, 'history.depth'))).toContain(
      'HISTORY_DEPTH_MISMATCH',
    );
    assertIdentityAgreement(outcome.result.checks, HISTORY_CYCLE);
  });

  it('fails only history.meaning for a coherently restored wrong normalized meaning', () => {
    const facts = chainFacts();
    const actions = [...facts.actions];
    actions[2] = {
      ...actions[2],
      meaningFingerprint: 'c'.repeat(64),
    } as HistoryActionFact;
    const evidence = { ...facts, actions };
    const evaluation = evaluateHistoryOracle(evidence);
    expect(evaluation.harnessInvalid).toBe(false);

    const outcome = evaluateHistoryLiveChecks(historyInput(evidence));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(statusFor(outcome.result.checks, 'history.meaning')).toBe('FAIL');
    expect(statusFor(outcome.result.checks, 'history.depth')).toBe('PASS');
    const transitions = checkFor(outcome.result.checks, 'history.meaning')?.actual
      .transitions as readonly Record<string, unknown>[];
    expect(transitions[2]?.meaningFingerprintEqual).toBe(false);
    expect(checkFor(outcome.result.checks, 'history.meaning')?.actual.authority).toBe('current');
    assertIdentityAgreement(outcome.result.checks, HISTORY_CYCLE);
  });

  it('never lets one failing check rescue the other', () => {
    const facts = chainFacts();
    const actions = [...facts.actions];
    actions[5] = { ...actions[5], historyAfter: tuple(2, 1) } as HistoryActionFact;
    actions[1] = { ...actions[1], meaningStructurallyEqual: false } as HistoryActionFact;
    const evidence = { ...facts, actions, finalHistory: tuple(2, 1) };
    const outcome = evaluateHistoryLiveChecks(historyInput(evidence));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(statusFor(outcome.result.checks, 'history.depth')).toBe('FAIL');
    expect(statusFor(outcome.result.checks, 'history.meaning')).toBe('FAIL');
    expect(outcome.result.checks.every((check) => check.actual.authority === 'current')).toBe(true);
  });

  it('treats a driver-declared contradictory expectation as malformed authority', () => {
    const facts = chainFacts();
    const actions = [...facts.actions];
    actions[0] = {
      ...actions[0],
      expectedHistory: tuple(1, 1),
      historyTupleExact: true,
    } as HistoryActionFact;
    const outcome = evaluateHistoryLiveChecks(historyInput({ ...facts, actions }));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(statusFor(outcome.result.checks, 'history.depth')).toBe('UNUSABLE');
    expect(checkFor(outcome.result.checks, 'history.depth')?.actual.authority).toBe('malformed');
    expect(outcome.result.issues.map((entry) => entry.code)).toContain(
      'HISTORY_KERNEL_EXECUTION_AUTHORITY_UNUSABLE',
    );
  });

  it('produces UNUSABLE for missing/stale/torn/wrong-target/malformed/ambiguous chain authority', () => {
    const base = chainFacts();

    const caseList: readonly [string, HistoryEvidenceFacts, string][] = [
      ['no setup checkpoints', { ...base, setup: [] }, 'missing'],
      ['no transitions', { ...base, actions: [] }, 'missing'],
      [
        'duplicated transition chain',
        { ...base, actions: [...base.actions, base.actions[0] as HistoryActionFact] },
        'ambiguous',
      ],
      [
        'non-object setup checkpoint',
        {
          ...base,
          setup: base.setup.map((entry, index) =>
            index === 1 ? ('not-a-checkpoint' as unknown as HistorySetupFact) : entry,
          ),
        },
        'malformed',
      ],
      [
        'wrong cross-subject setup role',
        {
          ...base,
          setup: base.setup.map((entry, index) =>
            index === 2 ? { ...entry, role: 'created-vector' } : entry,
          ),
        },
        'malformed',
      ],
      [
        'non-native Undo control',
        {
          ...base,
          actions: base.actions.map((action, index) =>
            index === 3 ? ({ ...action, controlNativeTag: 'DIV' } as HistoryActionFact) : action,
          ),
        },
        'malformed',
      ],
      [
        'mislabelled control title',
        {
          ...base,
          actions: base.actions.map((action, index) =>
            index === 3 ? ({ ...action, controlTitle: 'Undo (⌘Z)' } as HistoryActionFact) : action,
          ),
        },
        'malformed',
      ],
      [
        'transition outside the accepted order',
        {
          ...base,
          actions: base.actions.map((action, index) =>
            index === 2 ? ({ ...action, stepId: 'history.undo-4' } as HistoryActionFact) : action,
          ),
        },
        'malformed',
      ],
      [
        'non-advancing post-action revision',
        {
          ...base,
          actions: base.actions.map((action, index) => {
            if (index !== 1) return action;
            const stale = action.postActionRevision;
            return {
              ...action,
              postActionRevision: action.preActionRevision,
              observationId: `history:${action.stepId}:${action.preActionRevision}`,
              idle: { ...action.idle!, observationRevision: action.preActionRevision },
            } as HistoryActionFact;
          }),
        },
        'stale',
      ],
      [
        'stale idle observation revision',
        {
          ...base,
          actions: base.actions.map((action, index) =>
            index === 2
              ? ({
                  ...action,
                  idle: { ...action.idle!, observationRevision: 999 },
                } as HistoryActionFact)
              : action,
          ),
        },
        'stale',
      ],
      [
        'idle below the compiled stable frames',
        {
          ...base,
          actions: base.actions.map((action, index) =>
            index === 4
              ? ({ ...action, idle: { ...action.idle!, stableFrames: 1 } } as HistoryActionFact)
              : action,
          ),
        },
        'stale',
      ],
      [
        'observation identity not bound to its revision',
        {
          ...base,
          actions: base.actions.map((action, index) =>
            index === 0
              ? ({ ...action, observationId: 'history:history.undo-1:999' } as HistoryActionFact)
              : action,
          ),
        },
        'stale',
      ],
      [
        'reused observation identity',
        {
          ...base,
          actions: base.actions.map((action, index) =>
            index === 5
              ? ({
                  ...action,
                  observationId: base.actions[4]?.observationId ?? null,
                } as HistoryActionFact)
              : action,
          ),
        },
        'ambiguous',
      ],
      [
        'recaptured torn candidate',
        {
          ...base,
          actions: base.actions.map((action, index) =>
            index === 2 ? ({ ...action, tornRecaptureCount: 1 } as HistoryActionFact) : action,
          ),
        },
        'torn',
      ],
      [
        'no causal transition observed',
        {
          ...base,
          actions: base.actions.map((action, index) =>
            index === 1 ? ({ ...action, transitionObserved: false } as HistoryActionFact) : action,
          ),
        },
        'missing',
      ],
      ['empty retained Layout identity', { ...base, retainedLayoutId: '' }, 'wrong-target'],
      [
        'absent retained Layout identity',
        { ...base, retainedLayoutId: null as unknown as string },
        'missing',
      ],
      [
        'final tuple does not correlate with the last transition',
        { ...base, finalHistory: tuple(1, 2) },
        'stale',
      ],
      [
        'pre-action baseline is not the exact H3',
        {
          ...base,
          actions: base.actions.map((action, index) =>
            index === 0 ? ({ ...action, historyBefore: tuple(2, 1) } as HistoryActionFact) : action,
          ),
        },
        'stale',
      ],
    ];

    for (const [label, evidence, expectedAuthority] of caseList) {
      const outcome = evaluateHistoryLiveChecks(historyInput(evidence));
      expect(outcome.ok, label).toBe(true);
      if (!outcome.ok) continue;
      for (const check of outcome.result.checks) {
        expect(check.status, label).toBe('UNUSABLE');
        expect(check.actual.authority, label).toBe(expectedAuthority);
      }
    }
  });

  it('is UNUSABLE for readiness timeout/invalidated/unavailable/stale observations', () => {
    for (const outcome of ['timeout', 'invalidated', 'unavailable', 'stale'] as const) {
      const readiness = readinessFacts() as Record<string, unknown>;
      const result = evaluateHistoryLiveChecks(
        historyInput(PASS_CHAIN, {
          readiness: {
            ...readiness,
            observation: {
              ...(readiness.observation as Record<string, unknown>),
              outcome,
            },
          },
        }),
      );
      expect(result.ok, outcome).toBe(true);
      if (!result.ok) continue;
      expect(result.result.checks.every((check) => check.status === 'UNUSABLE')).toBe(true);
      expect(result.result.issues.map((entry) => entry.code)).toContain(
        'HISTORY_KERNEL_READINESS_AUTHORITY_UNUSABLE',
      );
    }
  });

  it('is UNUSABLE (malformed) for a readiness policy that diverges from the compiled authority', () => {
    const readiness = readinessFacts() as Record<string, unknown>;
    const result = evaluateHistoryLiveChecks(
      historyInput(PASS_CHAIN, {
        readiness: {
          ...readiness,
          policy: {
            ...(readiness.policy as Record<string, unknown>),
            deadlineMs: ((readiness.policy as Record<string, unknown>).deadlineMs as number) + 1000,
          },
        },
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.checks.every((check) => check.status === 'UNUSABLE')).toBe(true);
    expect(result.result.checks.every((check) => check.actual.authority === 'malformed')).toBe(
      true,
    );
    expect(result.result.issues.map((entry) => entry.code)).toContain(
      'HISTORY_KERNEL_READINESS_POLICY_MISMATCH',
    );
  });

  it('treats a malformed Oracle evaluation as malformed primitive authority', () => {
    const wrongTuple = chainFacts({
      setup: setupFacts().map((entry, index) => (index === 2 ? { ...entry, pastDepth: 9 } : entry)),
    });
    const evaluation = evaluateHistoryOracle(wrongTuple);
    expect(evaluation.harnessInvalid).toBe(true);
    expect(evaluation.primitiveFacts.authority).toBe('malformed');
    expect(evaluation.primitiveFacts.setup).toBeNull();
    expect(evaluation.primitiveFacts.transitions).toBeNull();
    expect(evaluation.primitiveFacts.checks.every((check) => check.predicateMet === false)).toBe(
      true,
    );

    const outcome = evaluateHistoryLiveChecks(historyInput(wrongTuple));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.checks.every((check) => check.status === 'UNUSABLE')).toBe(true);
    for (const check of outcome.result.checks) {
      expect(check.actual.authority).toBe('malformed');
      expect(oracleViewOf(check).mismatch).toBe(false);
    }
  });

  it('produces UNUSABLE for a declared check with no accepted fact when the Oracle never ran', () => {
    const outcome = evaluateHistoryLiveChecks(historyInput(PASS_CHAIN, { oracle: null }));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.facts.checks).toEqual([]);
    expect(outcome.facts.oracleFacts).toBeNull();
    for (const checkId of CHECK_IDS) {
      expect(statusFor(outcome.result.checks, checkId)).toBe('UNUSABLE');
      expect(checkFor(outcome.result.checks, checkId)?.actual.authority).toBe('missing');
    }
    expect(outcome.result.issues.map((entry) => entry.code)).toContain(
      'HISTORY_KERNEL_FACT_CHECK_MISSING',
    );
  });

  it('passes the observed evidence roles through untouched and never invents a role', () => {
    const observed = evidenceAll();
    const outcome = evaluateHistoryLiveChecks(historyInput(PASS_CHAIN, { evidence: observed }));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.facts.evidence).toEqual(observed);
  });

  it('never lets a diagnostic evidence item rescue a required check', () => {
    const outcome = evaluateHistoryLiveChecks(
      historyInput(PASS_CHAIN, {
        evidence: evidenceAll({ 'history.transition-snapshot': 'diagnostic-only' }),
      }),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.checks.every((check) => check.status === 'UNUSABLE')).toBe(true);
    expect(outcome.result.issues.map((entry) => entry.code)).toContain(
      'HISTORY_KERNEL_EVIDENCE_DIAGNOSTIC_ONLY',
    );
    for (const check of outcome.result.checks) {
      expect(check.evidenceIds).not.toContain('history.transition-snapshot');
    }
  });

  it('is UNUSABLE only for the checks that require a missing evidence item', () => {
    const outcome = evaluateHistoryLiveChecks(
      historyInput(PASS_CHAIN, { evidence: evidenceAll({ observation: 'missing' }) }),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(statusFor(outcome.result.checks, 'history.depth')).toBe('UNUSABLE');
    expect(statusFor(outcome.result.checks, 'history.meaning')).toBe('PASS');
    expect(checkFor(outcome.result.checks, 'history.depth')?.actual.authority).toBe('missing');
    expect(checkFor(outcome.result.checks, 'history.depth')?.evidenceIds).toEqual([
      'history.source-snapshot',
      'history.transition-snapshot',
    ]);
  });

  it('reports undeclared evidence claiming authority without consuming it', () => {
    const outcome = evaluateHistoryLiveChecks(
      historyInput(PASS_CHAIN, {
        evidence: [
          ...evidenceAll(),
          { evidenceId: 'uncalibrated.extra', availability: 'authoritative' },
        ],
      }),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.issues.map((entry) => entry.code)).toContain(
      'HISTORY_KERNEL_EVIDENCE_UNDECLARED',
    );
    for (const check of outcome.result.checks) {
      expect(check.evidenceIds).not.toContain('uncalibrated.extra');
    }
  });

  it('carries no legacy harnessInvalid or boolean passed authority into the kernel facts', () => {
    const adaptation = adaptHistoryLiveFacts(historyInput(PASS_CHAIN));
    expect(adaptation.ok).toBe(true);
    if (!adaptation.ok) return;
    const facts = adaptation.facts as HistoryKernelFacts;
    expect(Object.hasOwn(facts, 'harnessInvalid')).toBe(false);
    expect(Object.hasOwn(facts, 'checks')).toBe(true);
    for (const check of facts.checks) {
      expect(Object.hasOwn(check, 'passed')).toBe(false);
      expect(Object.hasOwn(check, 'unusable')).toBe(false);
      expect(typeof check.authority).toBe('string');
      expect(typeof check.currentness).toBe('string');
      expect(typeof check.sourcesAgree).toBe('boolean');
      expect(typeof check.mismatch).toBe('boolean');
    }
  });
});

// ── Legacy authority elimination ────────────────────────────────────────────

describe('[P7-B2-B5] legacy authority elimination', () => {
  it('derives facts only from additive primitive observations, never from legacy booleans', () => {
    const baseline = evaluateHistoryLiveChecks(historyInput(PASS_CHAIN));
    expect(baseline.ok).toBe(true);
    if (!baseline.ok) return;
    expect(baseline.result.checks.every((check) => check.status === 'PASS')).toBe(true);

    // Flip every legacy composite check-result boolean and the aggregate
    // harness-validity flag while leaving the additive primitive facts
    // byte-identical. The adapter must not observe any difference.
    const evaluation = evaluateHistoryOracle(PASS_CHAIN);
    const flipped = {
      ...evaluation,
      checks: evaluation.checks.map((check) => ({ ...check, passed: !check.passed })),
      passed: !evaluation.passed,
      harnessInvalid: !evaluation.harnessInvalid,
    };
    const afterFlip = evaluateHistoryLiveChecks(
      historyInput(PASS_CHAIN, {
        oracle: {
          primitiveFacts: flipped.primitiveFacts,
          diagnostics: flipped.diagnostics,
        } as unknown as HistoryLiveEvaluationObservation,
      }),
    );
    expect(afterFlip.ok).toBe(true);
    if (!afterFlip.ok) return;
    expect(afterFlip.result.checks).toEqual(baseline.result.checks);
    expect(afterFlip.facts).toEqual(baseline.facts);

    // A genuine primitive predicate change must change the adapter output.
    const tamperedPrimitives = {
      ...evaluation.primitiveFacts,
      checks: evaluation.primitiveFacts.checks.map((check) => ({
        ...check,
        predicateMet: false,
      })),
    };
    const afterPrimitive = evaluateHistoryLiveChecks(
      historyInput(PASS_CHAIN, {
        oracle: {
          primitiveFacts: tamperedPrimitives,
          diagnostics: evaluation.diagnostics,
        } as unknown as HistoryLiveEvaluationObservation,
      }),
    );
    expect(afterPrimitive.ok).toBe(true);
    if (!afterPrimitive.ok) return;
    expect(afterPrimitive.result.checks.every((check) => check.status === 'FAIL')).toBe(true);
    for (const check of afterPrimitive.result.checks) {
      expect(check.actual.authority).toBe('current');
      expect(oracleViewOf(check).currentness).toBe('current');
    }
  });

  it('derives malformed authority from the primitive authority, not the aggregate harness flag', () => {
    const evaluation = evaluateHistoryOracle(PASS_CHAIN);
    expect(evaluation.harnessInvalid).toBe(false);
    const primitives = {
      ...evaluation.primitiveFacts,
      authority: 'malformed' as const,
      checks: evaluation.primitiveFacts.checks.map((check) => ({
        ...check,
        predicateMet: true,
      })),
    };
    const outcome = evaluateHistoryLiveChecks(
      historyInput(PASS_CHAIN, {
        oracle: {
          primitiveFacts: primitives,
          diagnostics: evaluation.diagnostics,
        } as unknown as HistoryLiveEvaluationObservation,
      }),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.checks.every((check) => check.status === 'UNUSABLE')).toBe(true);
    for (const check of outcome.result.checks) {
      expect(check.actual.authority).toBe('malformed');
      expect(oracleViewOf(check).mismatch).toBe(false);
    }
  });

  it('projects the chain-agreement primitive into the structured sourcesAgree fact', () => {
    const evaluation = evaluateHistoryOracle(PASS_CHAIN);
    expect(evaluation.primitiveFacts.preActionChainCorrelates).toBe(true);
    const brokenChain = {
      ...evaluation.primitiveFacts,
      preActionChainCorrelates: false,
    };
    const projected = projectHistoryLiveFacts({
      primitiveFacts: brokenChain,
      diagnostics: evaluation.diagnostics,
    });
    expect(projected.length).toBeGreaterThan(0);
    for (const entry of projected) {
      expect(entry.sourcesAgree).toBe(false);
      expect(entry.authority).toBe('current');
    }
    const correlated = projectHistoryLiveFacts({
      primitiveFacts: evaluation.primitiveFacts,
      diagnostics: evaluation.diagnostics,
    });
    for (const entry of correlated) {
      expect(entry.sourcesAgree).toBe(true);
    }
  });

  it('emits no aggregate harnessInvalid and no boolean oracle authority in the result payload', () => {
    const outcome = evaluateHistoryLiveChecks(historyInput(PASS_CHAIN));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    for (const check of outcome.result.checks) {
      expect(Object.hasOwn(check.actual, 'harnessInvalid')).toBe(false);
      expect(Object.hasOwn(check.actual.oracle as object, 'passed')).toBe(false);
      expect(oracleViewOf(check)).toEqual({
        authority: 'current',
        currentness: 'current',
        sourcesAgree: true,
        mismatch: false,
      });
      const oracleFacts = check.actual.oracleFacts as Record<string, unknown>;
      expect(oracleFacts.authority).toBe('current');
      expect(oracleFacts.chainAgreement).toBe(true);
      expect(Array.isArray(oracleFacts.setup)).toBe(true);
      expect(Array.isArray(oracleFacts.transitions)).toBe(true);
    }
  });

  it('preserves the active Oracle consumers additively', () => {
    const evaluation = evaluateHistoryOracle(PASS_CHAIN);
    // Legacy fields the active runtime still consumes remain exactly as before.
    expect(evaluation.checks.map((check) => check.checkId).sort()).toEqual(
      [...HISTORY_REQUIRED_CHECKS].sort(),
    );
    expect(evaluation.checks.every((check) => check.passed)).toBe(true);
    expect(evaluation.passed).toBe(true);
    expect(evaluation.harnessInvalid).toBe(false);
    expect(evaluation.diagnostics).toEqual([]);
    // The additive primitive facts carry only named primitives, never a boolean
    // check result or aggregate harness flag.
    expect(evaluation.primitiveFacts.authority).toBe('current');
    expect(evaluation.primitiveFacts.retainedLayoutId).toBe('layout-a');
    expect(evaluation.primitiveFacts.preActionChainCorrelates).toBe(true);
    expect(evaluation.primitiveFacts.setup?.map((entry) => entry.checkpointId)).toEqual([
      'H0',
      'H1',
      'H2',
      'H3',
    ]);
    expect(evaluation.primitiveFacts.transitions?.map((entry) => entry.order)).toEqual([
      0, 1, 2, 3, 4, 5,
    ]);
    expect(
      evaluation.primitiveFacts.transitions?.every(
        (entry) =>
          entry.controlNativeTag === HISTORY_CONTROL_NATIVE_TAG &&
          entry.controlButtonType === HISTORY_CONTROL_BUTTON_TYPE &&
          entry.controlVisible === true &&
          entry.controlEnabledBeforeDispatch === true &&
          entry.dispatchCount === 1 &&
          entry.revisionAdvanced === true &&
          entry.idle !== null &&
          entry.idle.observationRevision === entry.postActionRevision &&
          entry.tornRecaptureCount === 0,
      ),
    ).toBe(true);
    expect(evaluation.primitiveFacts.finalHistory).toEqual({
      pastDepth: 3,
      futureDepth: 0,
      baselineClean: false,
    });
    expect(evaluation.primitiveFacts.checks.map((check) => check.checkId).sort()).toEqual(
      [...HISTORY_REQUIRED_CHECKS].sort(),
    );
    expect(Object.hasOwn(evaluation.primitiveFacts, 'passed')).toBe(false);
    expect(Object.hasOwn(evaluation.primitiveFacts, 'status')).toBe(false);
    expect(Object.hasOwn(evaluation.primitiveFacts, 'harnessInvalid')).toBe(false);
    for (const check of evaluation.primitiveFacts.checks) {
      expect(Object.hasOwn(check, 'passed')).toBe(false);
      expect(typeof check.predicateMet).toBe('boolean');
    }
    // The adapter's structured projection never carries the raw legacy booleans.
    const projected = projectHistoryLiveFacts({
      primitiveFacts: evaluation.primitiveFacts,
      diagnostics: evaluation.diagnostics,
    });
    for (const entry of projected) {
      expect(Object.hasOwn(entry, 'passed')).toBe(false);
      expect(Object.hasOwn(entry, 'unusable')).toBe(false);
      expect(typeof entry.authority).toBe('string');
      expect(typeof entry.mismatch).toBe('boolean');
    }
  });
});

// ── No adapter policy, no active imports, no legacy authority ───────────────

describe('[P7-B2-B5] inactive adapter invariants', () => {
  const source = (relative: string): string => readFileSync(path.join(skillRoot, relative), 'utf8');
  const adapterSource = source('src/adapters/history-live-facts.ts');
  const kernelSource = source('src/kernels/history-kernel.ts');

  it('does not import any active executor, Oracle, evidence writer, CLI, browser, or classifier', () => {
    expect(adapterSource).not.toMatch(
      /from '\.\.\/(runtime|oracles|evidence|cli|browser|workflows|commands)\//,
    );
    for (const token of [
      'execute-plan',
      'execute-history-plan',
      'evaluateHistoryOracle',
      'writeRunRecord',
      'outcomes',
      'contracts/execution',
    ]) {
      expect(adapterSource, token).not.toContain(token);
    }
  });

  it('owns no required-check array, fallback id, deadline, tolerance, visual, or normalization literal', () => {
    for (const token of [
      "'history.depth'",
      "'history.meaning'",
      "'history-cross-subject-v1'",
      "'history-transition-v1'",
      "'INTERACTIVE_HISTORY_V1'",
      'deadlineMs',
      'signalWatchdogMs',
      'fallbackCadenceMs',
      'quiescenceRequired',
      'stableFrameRequired',
      '5000',
    ]) {
      expect(adapterSource, token).not.toContain(token);
    }
    // The raw post-transition idle observation (including its stable-frame
    // count) is a delivered primitive fact; the adapter never reads the
    // compiled readiness policy projection and never decides with it.
    const policyFreeCode = adapterSource
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    expect(policyFreeCode).not.toMatch(/readiness\.(policy|observation)/);
    expect(policyFreeCode).not.toContain('profile.readiness');
  });

  it('performs no authoring-catalogue reload or route/Subject/scenario dispatch', () => {
    for (const token of [
      'loadCorrectnessCatalogue',
      'loadCatalogueBundle',
      'compileResolvedCorrectnessProfile',
      'resolveRouteSelection',
      'routeSelections',
      "subjectId === '",
      "variant === '",
      'switch (',
    ]) {
      expect(adapterSource, token).not.toContain(token);
    }
  });

  it('never defaults an evidence role and never translates a boolean into a final status', () => {
    const code = adapterSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    expect(code).not.toMatch(/\bpassed\b/);
    expect(code).not.toMatch(/\bunusable\b/);
    expect(code).not.toMatch(/\bharnessInvalid\b/);
    expect(code).not.toMatch(/\.status\b/);
    expect(code).not.toMatch(/'PASS'|'FAIL'/);
    // The only nested read surface is the additive primitive view.
    expect(code).toContain('primitiveFacts');
    // The reconciled kernel fact contract no longer exposes legacy authority.
    expect(kernelSource).not.toMatch(/readonly passed: boolean/);
    expect(kernelSource).not.toMatch(/readonly unusable: boolean/);
    expect(kernelSource).not.toMatch(/readonly harnessInvalid: boolean/);
    expect(kernelSource).not.toContain('HISTORY_KERNEL_HARNESS_INVALID');
  });

  it('is inactive: not exported from the public barrel and unreferenced by active modules', () => {
    const indexSource = source('src/index.ts');
    expect(indexSource).not.toContain('history-live-facts');
    expect(indexSource).not.toContain('adaptHistoryLiveFacts');
    expect(indexSource).not.toContain('evaluateHistoryLiveChecks');
  });

  it('fails closed with a structured diagnostic on every reported issue', () => {
    const failure = adaptHistoryLiveFacts({
      ...historyInput(PASS_CHAIN),
      evidence: [{ evidenceId: 'x', availability: 'nope' } as never],
    });
    expect(failure.ok).toBe(false);
    if (failure.ok) return;
    expect(failure.status).toBe('HARNESS_BLOCKED');
    expect(failure.launchAttempted).toBe(false);
    expect(failure.diagnostic.code).toBe('UNUSABLE_EVIDENCE');
    expect(failure.diagnostic.detail).toContain('HISTORY_LIVE_EVIDENCE_FACT_INVALID');
  });
});

// ── Compiled compatibility mutation matrix ──────────────────────────────────

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

function mutatedEnvelope(
  envelope: MaterializedExecutionEnvelopeV1,
  leafPath: string,
): MaterializedExecutionEnvelopeV1 {
  const clone = structuredClone(envelope) as unknown as Record<string, unknown>;
  mutateLeaf(clone, `correctnessProfile.${leafPath}`);
  return clone as unknown as MaterializedExecutionEnvelopeV1;
}

describe('[P7-B2-B5] compiled compatibility mutation matrix', () => {
  const leafPaths: string[] = [];
  collectLeafPaths(profile, '', leafPaths);
  const baseInput = historyInput(PASS_CHAIN);

  it('covers the complete compiled cross-subject History profile projection', () => {
    expect(leafPaths.length).toBeGreaterThanOrEqual(150);
  });

  it('detects every single-leaf mutation of the compiled History profile', () => {
    for (const leafPath of leafPaths) {
      const adaptation = adaptHistoryLiveFacts({
        ...baseInput,
        envelope: mutatedEnvelope(historyCase.envelope, leafPath),
      });
      expect(adaptation.ok, `mutation of ${leafPath} was not detected`).toBe(false);
    }
  });

  it('detects a mutated component fingerprint retained against the stored resolved identity', () => {
    const clone = structuredClone(profile) as unknown as Record<string, unknown>;
    (clone.componentFingerprints as Record<string, unknown>).oracle = 'c'.repeat(64);
    const adaptation = adaptHistoryLiveFacts({
      ...baseInput,
      envelope: {
        ...historyCase.envelope,
        correctnessProfile: clone,
      } as unknown as MaterializedExecutionEnvelopeV1,
    });
    expect(adaptation.ok).toBe(false);
  });

  it('keeps an unrelated valid envelope accepted after the mutation matrix', () => {
    const adaptation = adaptHistoryLiveFacts(baseInput);
    expect(adaptation.ok).toBe(true);
    if (adaptation.ok) {
      expect(adaptation.facts.oracleFacts).not.toBeNull();
      expect(adaptation.facts.checks).toHaveLength(CHECK_IDS.length);
      expect(isFullCanonicalFingerprint(profile.resolvedFingerprint)).toBe(true);
    }
  });
});
