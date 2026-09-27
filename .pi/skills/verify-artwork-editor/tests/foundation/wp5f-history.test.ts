/**
 * WP5 Slice 5-F — cross-subject history catalogue, contract, and run-record v3
 * migration tests (ADR 0019 R4/R10/R11; ADR 0020 A4).
 *
 * These are foundation (pure) tests for the closed history contract, the atomic
 * workflow-catalogue-v4/step-v2 migration, the delivered history fixture, and
 * the run-record v3 writer/reader migration with explicit v1/v2 legacy
 * discrimination.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { loadCatalogueBundle } from '../../src/catalogue/load';
import { resolveBindingFixture } from '../../src/catalogue/fixtures';
import {
  HISTORY_ACTION_STEPS,
  HISTORY_CONTROLS,
  HISTORY_REQUIRED_CHECKS,
  HISTORY_SETUP_CHECKPOINTS,
  HISTORY_TRANSITION_PROFILE_ID,
  INTERACTIVE_HISTORY_V1_DEADLINE_MS,
  historyTupleEquals,
  historyWorkflowStepsAgree,
} from '../../src/contracts/history-observation';
import {
  CHECK_RESULT_CONTRACT_SCHEMA_VERSION,
  DIAGNOSTIC_RUN_RECORD_SCHEMA_VERSION,
} from '../../src/contracts/schema-versions';
import type {
  ActionCycleCorrectnessIdentity,
  CorrectnessCheckResult,
} from '../../src/contracts/correctness';
import type {
  FinalCurrentChildRecordV4,
  FinalNestedProjectionV4,
} from '../../src/contracts/final-record-v4';
import { readFinalRecord } from '../../src/contracts/final-record-reader';
import type { AssembleFinalPublicRunRecordV4Input } from '../../src/contracts/final-public-record';
import { historyEvidenceViolations } from '../../src/evidence/public-dto';
import {
  buildPublicLaunchFacts,
  buildNotEstablishedOwnership,
} from '../../src/evidence/public-dto';
import { readFinalPublicRecordFile } from '../../src/evidence/final-reader';
import { writeFinalPublicRunRecordV4 } from '../../src/evidence/final-writer';
import {
  ACCEPTED_PRE_5F_V2_LABEL,
  LEGACY_V1_LABEL,
  LEGACY_V3_LABEL,
  classifyLegacyRunRecord,
  parseLegacyRunRecordOrThrow,
} from '../../src/evidence/reader';
import { RunRecordWriteError } from '../../src/evidence/writer';
import { resolveWorkflowSteps } from '../../src/workflows/steps';

const roots: string[] = [];

function tempRoot(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'verify-wp5f-history-'));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  while (roots.length > 0) {
    const dir = roots.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function tuple(pastDepth: number, futureDepth: number) {
  return { pastDepth, futureDepth, baselineClean: pastDepth === 0 && futureDepth === 0 };
}

/** The product-exact pre-action chain: H3 then each prior post-action tuple. */
function historyBeforeFor(index: number) {
  if (index === 0) return { pastDepth: 3, futureDepth: 0, baselineClean: false };
  const prior = HISTORY_ACTION_STEPS[index - 1]?.expectedHistory;
  return prior ?? { pastDepth: 3, futureDepth: 0, baselineClean: false };
}

/** A well-formed closed history projection built from the exact contract. */
function validHistory() {
  return {
    schemaVersion: 1,
    normalizationProfileId: 'artwork-product-meaning-v1',
    readinessProfileId: 'history-transition-v1',
    oracleProfileId: 'history-cross-subject-v1',
    timingCategory: 'INTERACTIVE_HISTORY_V1',
    deadlineMs: 5000,
    retainedLayoutId: 'layout-a',
    setup: HISTORY_SETUP_CHECKPOINTS.map((entry) => ({
      checkpointId: entry.checkpointId,
      role: entry.role,
      pastDepth: entry.pastDepth,
      futureDepth: entry.futureDepth,
      baselineClean: entry.pastDepth === 0,
      meaning: entry.meaning,
      meaningFingerprint: 'a'.repeat(64),
    })),
    actions: HISTORY_ACTION_STEPS.map((step) => ({
      actionEpochId: `history:${step.stepId}:${step.stepIndex * 2 + 10}`,
      stepIndex: step.stepIndex,
      stepId: step.stepId,
      control: step.control,
      controlAccessibleName: HISTORY_CONTROLS[step.control].accessibleName,
      controlTitle: HISTORY_CONTROLS[step.control].title,
      controlNativeTag: 'BUTTON',
      controlButtonType: 'button',
      controlVisible: true,
      controlEnabledBeforeDispatch: true,
      dispatchCount: 1 as const,
      preActionRevision: step.stepIndex * 2 + 10,
      postActionRevision: step.stepIndex * 2 + 11,
      historyBefore: historyBeforeFor(step.stepIndex),
      historyAfter: step.expectedHistory,
      expectedHistory: step.expectedHistory,
      historyTupleExact: true,
      expectedMeaning: step.expectedMeaning,
      meaningFingerprint: 'b'.repeat(64),
      expectedMeaningFingerprint: 'b'.repeat(64),
      meaningStructurallyEqual: true,
      observationId: `history:${step.stepId}:${step.stepIndex * 2 + 11}`,
      idle: { stableFrames: 3, waitedMs: 40, observationRevision: step.stepIndex * 2 + 11 },
      tornRecaptureCount: 0,
      transitionObserved: true,
    })),
    finalHistory: { pastDepth: 3, futureDepth: 0, baselineClean: false },
    checks: [
      {
        checkId: 'history.depth',
        passed: true,
        evidenceIds: HISTORY_ACTION_STEPS.map(
          (step) => `observation:history:${step.stepId}:${step.stepIndex * 2 + 11}`,
        ),
      },
      {
        checkId: 'history.meaning',
        passed: true,
        evidenceIds: HISTORY_ACTION_STEPS.map(
          (step) => `observation:history:${step.stepId}:${step.stepIndex * 2 + 11}`,
        ),
      },
    ],
  };
}

const HEX = (char: string): string => char.repeat(64);

const COMPONENT_FINGERPRINTS = {
  readiness: HEX('a'),
  capture: HEX('b'),
  oracle: HEX('c'),
  capabilityBaseline: HEX('d'),
  subjectAddition: HEX('e'),
  requiredCheckSet: HEX('f'),
  tolerances: HEX('0'),
  visuals: HEX('1'),
  normalization: HEX('2'),
};

const RESOLVED_PROFILE_FINGERPRINT = HEX('9');

const ACTION_CYCLE: ActionCycleCorrectnessIdentity = {
  schemaVersion: CHECK_RESULT_CONTRACT_SCHEMA_VERSION,
  actionCycleId: 'history-cycle-1',
  resolvedProfileFingerprint: RESOLVED_PROFILE_FINGERPRINT,
  readinessFingerprint: COMPONENT_FINGERPRINTS.readiness,
};

/** One closed three-state check bound to the single history Action Cycle. */
function statusCheck(checkId: string): CorrectnessCheckResult {
  return {
    schemaVersion: CHECK_RESULT_CONTRACT_SCHEMA_VERSION,
    checkId,
    status: 'PASS',
    expected: {},
    actual: {},
    evidenceIds: [],
    toleranceRefs: [],
    visualRefs: [],
    normalizationRef: null,
    actionCycleRef: ACTION_CYCLE.actionCycleId,
    consumedComponentFingerprints: {
      resolvedProfile: RESOLVED_PROFILE_FINGERPRINT,
      requiredCheckSet: COMPONENT_FINGERPRINTS.requiredCheckSet,
      oracle: COMPONENT_FINGERPRINTS.oracle,
      capture: COMPONENT_FINGERPRINTS.capture,
      tolerances: COMPONENT_FINGERPRINTS.tolerances,
      visuals: COMPONENT_FINGERPRINTS.visuals,
      normalization: COMPONENT_FINGERPRINTS.normalization,
    },
  };
}

function actionCycleProjection(): FinalNestedProjectionV4 {
  return {
    schemaVersion: 4,
    family: 'action-cycle',
    actionCycles: [ACTION_CYCLE],
    readiness: {
      profileId: HISTORY_TRANSITION_PROFILE_ID,
      timingCategory: 'INTERACTIVE_HISTORY_V1',
      deadlineMs: INTERACTIVE_HISTORY_V1_DEADLINE_MS,
      signalWatchdogMs: 500,
      stableFrames: 3,
    },
  };
}

function historyProjection(checks: readonly CorrectnessCheckResult[]): FinalNestedProjectionV4 {
  return {
    schemaVersion: 4,
    family: 'history',
    normalizationProfileId: 'artwork-product-meaning-v1',
    readinessProfileId: HISTORY_TRANSITION_PROFILE_ID,
    oracleProfileId: 'history-cross-subject-v1',
    timingCategory: 'INTERACTIVE_HISTORY_V1',
    deadlineMs: INTERACTIVE_HISTORY_V1_DEADLINE_MS,
    retainedLayoutId: 'layout-a',
    finalHistory: { pastDepth: 3, futureDepth: 0, baselineClean: false },
    actionCycleRef: ACTION_CYCLE.actionCycleId,
    checks,
  };
}

/** A complete closed strict v4 child carrying the history nested projection. */
function validChild(checks: readonly CorrectnessCheckResult[]): FinalCurrentChildRecordV4 {
  return {
    schemaVersion: 4,
    runId: 'run-wp5f-history',
    caseId: 'case-wp5f-history',
    materializationFingerprint: HEX('3'),
    planFingerprint: HEX('4'),
    profile: 'diagnostic',
    observationId: 'obs-5',
    resolvedProfileFingerprint: RESOLVED_PROFILE_FINGERPRINT,
    componentFingerprints: COMPONENT_FINGERPRINTS,
    actionCycles: [ACTION_CYCLE],
    requiredChecks: checks,
    nestedProjections: [actionCycleProjection(), historyProjection(checks)],
  };
}

/** The safe operational projections the current public v4 record adds. */
function operationalFields(): Omit<AssembleFinalPublicRunRecordV4Input, 'child'> {
  return {
    provenance: 'diagnostic-request',
    evidenceDepth: 'deep',
    environmentCellId: 'chromium-desktop-1440x1000',
    repository: { commit: null, dirty: null, lockfileDigest: HEX('5') },
    fingerprints: {
      registry: 'r',
      applicationInventory: 'a',
      operationCatalogue: 'o',
      adapterCatalogue: 'ad',
      workflowCatalogue: 'w',
      workflowSteps: 'ws',
      coverageModel: null,
      readinessProfile: `${HISTORY_TRANSITION_PROFILE_ID}@1`,
      oracleProfile: 'history-cross-subject-v1@1',
    },
    adapter: { adapterId: 'default', compatibilityVersion: 1 },
    workflow: { workflowId: 'shared.history', version: 1 },
    fixture: {
      fixtureId: 'artwork-editor-history-undo-redo-text-v1',
      constructorId: 'artwork.two-layout-text.v1',
      constructorVersion: 1,
    },
    targets: [{ role: 'target', elementId: 'layout-a-text-1' }],
    readiness: {
      profileId: HISTORY_TRANSITION_PROFILE_ID,
      timingCategory: 'INTERACTIVE_HISTORY_V1',
      deadlineMs: INTERACTIVE_HISTORY_V1_DEADLINE_MS,
      wakeSource: 'store-signal',
      fallbackPollCount: 0,
      watchdogWaits: 0,
      rendererStableFrames: 3,
      timings: {},
    },
    behaviorOutcome: 'PASS',
    finalOutcome: 'PASS',
    launch: buildPublicLaunchFacts({
      attempted: false,
      pid: null,
      processGroupId: null,
      readinessMs: null,
      serverLogPath: null,
    }),
    ownership: buildNotEstablishedOwnership({
      runId: 'run-wp5f-history',
      allocationFailureCode: 'OWNERSHIP_UNKNOWN',
      requestedPort: null,
    }),
    cleanup: null,
    diagnostics: [],
    runError: null,
    recordedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('[WP5 Slice 5-F] history contract and catalogue migration', () => {
  it('migrates the workflow catalogue to v4/step v2 and declares exactly six history steps', () => {
    const bundle = loadCatalogueBundle();
    expect(bundle.workflowStepCatalogue.schemaVersion).toBe(4);
    expect(bundle.workflowStepCatalogue.stepSchemaVersion).toBe(2);
    const history = resolveWorkflowSteps(bundle.workflowStepCatalogue, 'shared.history');
    expect(history).not.toBeNull();
    expect(history?.capability).toBe('history');
    expect(historyWorkflowStepsAgree(history?.steps ?? [])).toBe(true);
    // Restore is now declared as the closed Save + runtime-handoff workflow.
    const serialize = resolveWorkflowSteps(bundle.workflowStepCatalogue, 'shared.serialize');
    expect(serialize).not.toBeNull();
    expect(serialize?.capability).toBe('frontendSerializeRestore');
    expect(serialize?.steps.map((step) => step.stepId)).toEqual([
      'serialize.save',
      'serialize.restore.capture',
    ]);
  });

  it('resolves the delivered history fixture for artwork/editor × history × undo-redo-text', () => {
    const bundle = loadCatalogueBundle();
    const fixture = resolveBindingFixture(bundle.fixtureCatalogue, {
      subjectId: 'artwork/editor',
      capability: 'history',
      scenarioId: 'undo-redo-text',
    });
    expect(fixture?.fixtureId).toBe('artwork-editor-history-undo-redo-text-v1');
    expect(fixture?.constructorId).toBe('artwork.two-layout-text.v1');
  });

  it('binds the exact six-transition depth and meaning tuples with no monotonic fallback', () => {
    expect(HISTORY_ACTION_STEPS.map((step) => step.control)).toEqual([
      'undo',
      'undo',
      'undo',
      'redo',
      'redo',
      'redo',
    ]);
    expect(HISTORY_ACTION_STEPS.map((step) => step.expectedHistory)).toEqual([
      { pastDepth: 2, futureDepth: 1, baselineClean: false },
      { pastDepth: 1, futureDepth: 2, baselineClean: false },
      { pastDepth: 0, futureDepth: 3, baselineClean: false },
      { pastDepth: 1, futureDepth: 2, baselineClean: false },
      { pastDepth: 2, futureDepth: 1, baselineClean: false },
      { pastDepth: 3, futureDepth: 0, baselineClean: false },
    ]);
    expect(HISTORY_ACTION_STEPS.map((step) => step.expectedMeaning)).toEqual([
      'M2',
      'M1',
      'M0',
      'M1',
      'M2',
      'M3',
    ]);
    expect(
      historyTupleEquals({ pastDepth: 2, futureDepth: 1 }, { pastDepth: 2, futureDepth: 1 }),
    ).toBe(true);
    expect(
      historyTupleEquals({ pastDepth: 3, futureDepth: 0 }, { pastDepth: 2, futureDepth: 1 }),
    ).toBe(false);
    expect(HISTORY_REQUIRED_CHECKS).toEqual(['history.depth', 'history.meaning']);
    expect(HISTORY_SETUP_CHECKPOINTS.map((entry) => entry.pastDepth)).toEqual([0, 1, 2, 3]);
  });
});

describe('[WP5 Slice 5-F] run-record v4 migration', () => {
  it('marks schema v3 as historical and discriminates v1/v2/v3 through the immutable legacy classifier', () => {
    // Schema 3 survives only as the explicit historical marker; the current
    // record is the strict v4 child read through the current reader.
    expect(DIAGNOSTIC_RUN_RECORD_SCHEMA_VERSION).toBe(3);
    expect(classifyLegacyRunRecord({ schemaVersion: 1 }).label).toBe(LEGACY_V1_LABEL);
    expect(classifyLegacyRunRecord({ schemaVersion: 2 })).toMatchObject({
      kind: 'legacy-v2',
      label: ACCEPTED_PRE_5F_V2_LABEL,
    });
    expect(classifyLegacyRunRecord({ schemaVersion: 3 })).toMatchObject({
      kind: 'legacy-v3',
      label: LEGACY_V3_LABEL,
    });
    // Neither the historical classifier nor the current reader accepts v4 here.
    expect(classifyLegacyRunRecord({ schemaVersion: 4 }).kind).toBe('unknown');
    expect(() => parseLegacyRunRecordOrThrow({ schemaVersion: 4 })).toThrow(/Unsupported/);

    const legacyRead = readFinalRecord({ schemaVersion: 3 });
    expect(legacyRead.legacy).toBe(true);
    expect(legacyRead.current).toBe(false);
    expect(legacyRead.ambiguous).toBe(true);
    expect(readFinalRecord({ schemaVersion: 99 }).kind).toBe('unknown');
  });

  it('accepts the closed v4 history projection and writes it durably', () => {
    const root = tempRoot();
    const checks = ['history.depth', 'history.meaning'].map(statusCheck);
    const written = writeFinalPublicRunRecordV4({
      child: validChild(checks),
      ...operationalFields(),
      evidenceRoot: root,
    });
    const record = JSON.parse(readFileSync(written.path, 'utf8')) as {
      schemaVersion: number;
      nestedProjections: { family: string; finalHistory?: unknown }[];
    };
    expect(record.schemaVersion).toBe(4);
    const history = record.nestedProjections.find((entry) => entry.family === 'history');
    expect(history?.finalHistory).toEqual({ pastDepth: 3, futureDepth: 0, baselineClean: false });

    const read = readFinalPublicRecordFile(written.path);
    expect(read.kind).toBe('current-v4');
    expect(read.current).toBe(true);
    expect(read.legacy).toBe(false);
  });

  it('rejects a wrong tuple, a wrong meaning, and a step-count deviation before writing', () => {
    const malformed = validHistory();
    (malformed.actions as Array<Record<string, unknown>>)[2] = {
      ...(malformed.actions[2] as Record<string, unknown>),
      historyAfter: tuple(1, 0),
    };
    expect(historyEvidenceViolations(malformed as unknown as Record<string, unknown>)).toContain(
      'actions[2]:history-after',
    );
    malformed.actions = malformed.actions.slice(0, 5);
    expect(historyEvidenceViolations(malformed as unknown as Record<string, unknown>)).toContain(
      'actions:not-six',
    );
    // The strict v4 writer refuses an invalid child, writing nothing.
    const root = tempRoot();
    const checks = ['history.depth', 'history.meaning'].map(statusCheck);
    const invalidChild = {
      ...validChild(checks),
      requiredChecks: checks.map((check) => ({ ...check, passed: true })),
    } as unknown as FinalCurrentChildRecordV4;
    expect(() =>
      writeFinalPublicRunRecordV4({
        child: invalidChild,
        ...operationalFields(),
        evidenceRoot: root,
      }),
    ).toThrow(RunRecordWriteError);
    expect(existsSync(path.join(root, 'run-record.json'))).toBe(false);
  });
});

describe('[WP5 Slice 5-F F3] closed history projection validation', () => {
  type History = ReturnType<typeof validHistory>;
  const violationsOf = (mutate: (history: History) => void): string[] => {
    const history = validHistory();
    mutate(history);
    return historyEvidenceViolations(history as unknown as Record<string, unknown>);
  };
  const action = (history: History, index: number): Record<string, unknown> =>
    history.actions[index] as unknown as Record<string, unknown>;

  it('accepts the exact product-exact projection with all six baselineClean false', () => {
    const history = validHistory();
    expect(
      history.actions.map(
        (entry) => (entry.expectedHistory as { baselineClean: boolean }).baselineClean,
      ),
    ).toEqual([false, false, false, false, false, false]);
    expect(historyEvidenceViolations(history as unknown as Record<string, unknown>)).toEqual([]);
  });

  it('rejects a hardcoded non-product-exact expected baselineClean', () => {
    const violations = violationsOf((history) => {
      action(history, 0).expectedHistory = {
        pastDepth: 2,
        futureDepth: 1,
        baselineClean: true,
      };
    });
    expect(violations).toContain('actions[0]:expected-history');
    expect(violations).toContain('actions[0]:history-after');
  });

  it('rejects a non-product-exact observed baselineClean', () => {
    const violations = violationsOf((history) => {
      action(history, 2).historyAfter = { pastDepth: 1, futureDepth: 2, baselineClean: true };
    });
    expect(violations).toContain('actions[2]:history-after:baseline-clean');
  });

  it('rejects a post revision that does not strictly follow the pre revision', () => {
    const violations = violationsOf((history) => {
      action(history, 1).postActionRevision = action(history, 1).preActionRevision;
    });
    expect(violations).toContain('actions[1]:revision-order');
  });

  it('rejects a broken historyBefore/historyAfter chain', () => {
    const violations = violationsOf((history) => {
      action(history, 3).historyBefore = { pastDepth: 3, futureDepth: 0, baselineClean: false };
    });
    expect(violations).toContain('actions[3]:history-chain');
  });

  it('rejects a non-native or mislabelled control identity', () => {
    const violations = violationsOf((history) => {
      const redo = action(history, 3);
      redo.controlTitle = 'Undo (⌘Z)';
      redo.controlNativeTag = 'DIV';
      redo.controlEnabledBeforeDispatch = false;
    });
    expect(violations).toContain('actions[3]:control-title');
    expect(violations).toContain('actions[3]:control-native-tag');
    expect(violations).toContain('actions[3]:control-enabled');
  });

  it('rejects a missing transitionObserved fact', () => {
    const violations = violationsOf((history) => {
      delete action(history, 4).transitionObserved;
    });
    expect(violations).toContain('actions[4]:transition-observed');
  });

  it('rejects a stale observation/action/idle identity', () => {
    const violations = violationsOf((history) => {
      const entry = action(history, 2);
      entry.observationId = 'history:history.undo-3:999';
      entry.actionEpochId = 'history:history.undo-3:999';
      entry.idle = { stableFrames: 3, waitedMs: 0, observationRevision: 999 };
    });
    expect(violations).toContain('actions[2]:observation-id');
    expect(violations).toContain('actions[2]:action-epoch-id');
    expect(violations).toContain('actions[2]:idle-revision');
  });

  it('rejects a check evidence ref that does not resolve to a recorded observation', () => {
    const violations = violationsOf((history) => {
      history.checks[0] = {
        checkId: 'history.depth',
        passed: true,
        evidenceIds: ['observation:nope'],
      };
    });
    expect(violations).toContain('checks:history.depth:evidence-ref');
  });

  it('rejects a passing check set with a missing required check', () => {
    const violations = violationsOf((history) => {
      history.checks = [
        {
          checkId: 'history.depth',
          passed: true,
          evidenceIds: [`observation:history:history.undo-1:11`],
        },
      ];
    });
    expect(violations).toContain('checks:not-two');
  });
});
