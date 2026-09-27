import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadCatalogueBundle, type CatalogueBundle } from '../../src/catalogue/load';
import { loadDiagnosticSuite, resolveSuiteRequests } from '../../src/catalogue/suite';
import type { ResolvedCorrectnessProfile } from '../../src/contracts/correctness';
import type { Capability } from '../../src/contracts/discriminants';
import { CHECK_RESULT_CONTRACT_SCHEMA_VERSION } from '../../src/contracts/schema-versions';
import { readFinalRecord } from '../../src/contracts/final-record-reader';
import { planCaseForExecution, type PlanForExecutionResult } from '../../src/planner/plan-case';
import type { MaterializedExecutionEnvelopeV1 } from '../../src/planner/execution-materialization';
import { resolveSkillRoot } from '../../src/runtime/paths';
import { evaluateGeometryDeltaOracle } from '../../src/index';
import { projectOrdinaryTextLiveFact } from '../../src/adapters/text-live-facts';
import {
  DIAGNOSTIC_EXECUTION_ISSUE_CODES,
  FINAL_EVALUATOR_DISPATCH,
  executeDiagnosticCase,
  resolveFinalEvaluatorDispatch,
  type DiagnosticExecutionInput,
} from '../../src/orchestration/diagnostic-execution';
import type { FinalExecutionPayload } from '../../src/runtime/execute-plan';
import {
  SUITE_AGGREGATION_ISSUE_CODES,
  aggregateSuiteChildren,
  executeSuiteChild,
  type SuiteChildExecutionInput,
  type SuiteChildOutcome,
} from '../../src/orchestration/suite-execution';
import type { ActionCycleCorrectnessIdentity } from '../../src/contracts/correctness';

/**
 * P7-B2-D1 focused proof: inactive representative Diagnostic and suite
 * orchestration (ADR 0029 §4 B2-D).
 *
 * The suites drive the real `planCaseForExecution` envelopes through the real
 * inactive B2-B adapters and kernels, dispatch by compiled evaluator
 * discriminant plus compatibility version, classify with the pure status
 * classifier, assemble strict v4 records, and aggregate suite children. They
 * prove the undelivered-envelope preallocation boundary, the external
 * pre-authority no-fabrication boundary, complete `UNUSABLE` post-launch
 * authority, the four status outcomes, identity/dispatch fail-closed behavior,
 * suite preservation/refusal, and the inactive import/write boundary.
 */

const skillRoot = resolveSkillRoot();
const bundle: CatalogueBundle = loadCatalogueBundle();
const resolvedRequests = resolveSuiteRequests(loadDiagnosticSuite('representative'));

function representativeRequest(fileName: string): unknown {
  const entry = resolvedRequests.find(
    (candidate) => path.basename(candidate.relativePath) === fileName,
  );
  if (entry === undefined) throw new Error(`missing representative request ${fileName}`);
  return entry.request;
}

interface PreparedCase {
  readonly fileName: string;
  readonly planning: Extract<PlanForExecutionResult, { status: 'PLANNED' }>;
  readonly envelope: MaterializedExecutionEnvelopeV1;
  readonly profile: ResolvedCorrectnessProfile;
  readonly route: {
    readonly subjectId: string;
    readonly capability: Capability;
    readonly variant: string | null;
  };
  readonly actionCycle: ActionCycleCorrectnessIdentity;
}

function prepare(fileName: string): PreparedCase {
  const planning = planCaseForExecution(representativeRequest(fileName), { catalogues: bundle });
  if (planning.status !== 'PLANNED')
    throw new Error(`${fileName} did not plan: ${planning.status}`);
  if (planning.envelope === null) throw new Error(`${fileName} produced no envelope`);
  const envelope = planning.envelope;
  const profile = envelope.correctnessProfile as unknown as ResolvedCorrectnessProfile;
  const intent = planning.materializedCase.intent;
  return {
    fileName,
    planning,
    envelope,
    profile,
    route: { subjectId: intent.subjectId, capability: intent.capability, variant: intent.variant },
    actionCycle: {
      schemaVersion: CHECK_RESULT_CONTRACT_SCHEMA_VERSION,
      actionCycleId: `b2d1-cycle-${fileName}`,
      resolvedProfileFingerprint: profile.resolvedFingerprint,
      readinessFingerprint: profile.componentFingerprints.readiness,
    },
  };
}

function readinessPolicy(profile: ResolvedCorrectnessProfile) {
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
    observation: { outcome: 'unusable', authority: 'missing' },
  };
}

function authoritativeEvidence(profile: ResolvedCorrectnessProfile) {
  return profile.requiredAuthoritativeEvidence.map((evidenceId) => ({
    evidenceId,
    availability: 'authoritative' as const,
  }));
}

function imageProjection(preparedCase: PreparedCase) {
  return {
    schemaVersion: 4 as const,
    family: 'image' as const,
    cycles: [
      {
        checkpoint: 'after-upload-current',
        mode: 'upload',
        outcome: 'HARNESS_BLOCKED',
        observationId: null,
        tornRecaptureCount: 0,
        actionCycleRef: preparedCase.actionCycle.actionCycleId,
      },
    ],
  };
}

function crosswordProjection(preparedCase: PreparedCase) {
  return {
    schemaVersion: 4 as const,
    family: 'crossword' as const,
    providerId: 'playwright-clock-fixed-wall-v1',
    namespace: 'crossword.create.date-now.v1',
    comparisonProfileId: 'crossword-determinism-comparison-v1',
    executions: (['A1', 'A2', 'B'] as const).map((executionRole) => ({
      executionRole,
      clockBaselineUtc: '2026-01-01T00:00:00.000Z',
      expectedSeed: 1,
      actualSeed: 1,
      hostLayoutId: 'b2d1-crossword-host',
      createdTargetId: 'b2d1-crossword-target',
      words: [],
      semanticDigest: '0'.repeat(64),
      actionCycleRef: preparedCase.actionCycle.actionCycleId,
    })),
    comparison: {
      sameSeedEqual: true,
      sameWordsEqual: true,
      sameSemanticDigestEqual: true,
      controlSeedDifferent: false,
      controlWordsEqual: true,
      controlSemanticDigestDifferent: false,
    },
  };
}

function historyProjection(preparedCase: PreparedCase) {
  return {
    schemaVersion: 4 as const,
    family: 'history' as const,
    normalizationProfileId: 'artwork-product-meaning-v1',
    readinessProfileId: preparedCase.profile.readiness.profileId,
    oracleProfileId: preparedCase.profile.oracle.oracleProfileId,
    timingCategory: preparedCase.profile.readiness.deadlineCategory,
    deadlineMs: preparedCase.profile.readiness.deadlineMs,
    retainedLayoutId: 'b2d1-history-layout',
    finalHistory: { pastDepth: 0, futureDepth: 0, baselineClean: true },
    actionCycleRef: preparedCase.actionCycle.actionCycleId,
  };
}

function restoreProjection(preparedCase: PreparedCase) {
  return {
    schemaVersion: 4 as const,
    family: 'restore' as const,
    normalizationProfileId: 'artwork-normalized-meaning-v1',
    readinessProfileId: preparedCase.profile.readiness.profileId,
    oracleProfileId: preparedCase.profile.oracle.oracleProfileId,
    timingCategory: preparedCase.profile.readiness.deadlineCategory,
    deadlineMs: preparedCase.profile.readiness.deadlineMs,
    scenarioId: 'serialize-roundtrip',
    sourceDocumentId: 'b2d1-restore-source',
    restoredDocumentId: 'b2d1-restore-restored',
    actionCycleRef: preparedCase.actionCycle.actionCycleId,
  };
}

/** A no-authority payload for the case's compiled family: complete `UNUSABLE`. */
function noAuthorityPayload(preparedCase: PreparedCase): FinalExecutionPayload {
  const kind = preparedCase.profile.oracle.evaluatorKind;
  switch (kind) {
    case 'geometry-delta':
      return {
        evaluatorKind: 'geometry-delta',
        projection: null,
        minimumDelta: null,
        delta: null,
        evidence: [],
      };
    case 'warped-text-envelope':
      return {
        evaluatorKind: 'warped-text-envelope',
        projection: null,
        minimumDelta: null,
        oracle: null,
        evidence: [],
      };
    case 'nested-object-affine':
      return {
        evaluatorKind: 'nested-object-affine',
        projection: null,
        minimumDelta: null,
        oracle: null,
        evidence: [],
      };
    case 'image-upload-replace':
      return {
        evaluatorKind: 'image-upload-replace',
        projection: imageProjection(preparedCase),
        mode: 'upload',
        targetId: 'b2d1-image-target',
        expectedLayoutId: 'b2d1-image-layout',
        expectedFrame: { x: 0, y: 0, width: 32, height: 24, rotation: 0 },
        expectedResource: {
          logicalId: 'image.upload-a',
          version: 1,
          sha256: 'f'.repeat(64),
          byteLength: 1,
          mimeType: 'image/png',
          dimensions: { width: 32, height: 24 },
          probes: [],
        },
        acceptedUpload: null,
        oracle: null,
        raster: null,
        readiness: readinessPolicy(preparedCase.profile) as never,
        evidence: [],
      };
    case 'crossword-determinism':
      return {
        evaluatorKind: 'crossword-determinism',
        projection: crosswordProjection(preparedCase),
        clock: null,
        sourceFingerprintExpected: '',
        executions: [],
        oracle: null,
        evidence: [],
      };
    case 'history-cross-subject':
      return {
        evaluatorKind: 'history-cross-subject',
        projection: historyProjection(preparedCase),
        retainedLayoutId: null,
        setup: [],
        actions: [],
        finalHistory: null,
        readiness: readinessPolicy(preparedCase.profile) as never,
        oracle: null,
        evidence: [],
      };
    case 'frontend-restore':
      return {
        evaluatorKind: 'frontend-restore',
        projection: restoreProjection(preparedCase),
        schemaVersion: 1,
        transition: {},
        meaning: {},
        rawSemantics: {},
        source: null,
        restored: null,
        setup: [],
        readiness: readinessPolicy(preparedCase.profile) as never,
        oracle: null,
        evidence: [],
      };
  }
}

function baseInput(
  preparedCase: PreparedCase,
  overrides: Partial<DiagnosticExecutionInput> = {},
): DiagnosticExecutionInput {
  return {
    planning: preparedCase.planning,
    prelaunch: {
      kind: 'reserved',
      allocationId: 'b2d1-allocation',
      executionInstanceId: 'b2d1-instance',
    },
    observation: {
      envelope: preparedCase.envelope,
      actionCycle: preparedCase.actionCycle,
      payload: noAuthorityPayload(preparedCase),
      observationId: 'b2d1-observation',
    },
    runId: `b2d1-run-${preparedCase.fileName}`,
    cleanupSucceeded: true,
    ...overrides,
  };
}

/** Wraps one executor family payload in the exact envelope-bound handoff. */
function observationOf(
  preparedCase: PreparedCase,
  payload: FinalExecutionPayload,
): DiagnosticExecutionInput['observation'] {
  return {
    envelope: preparedCase.envelope,
    actionCycle: preparedCase.actionCycle,
    payload,
    observationId: 'b2d1-observation',
  };
}

const REPRESENTATIVE_FILES = [
  'layer-text-move-drag-ordinary.json',
  'layer-text-move-drag-warped-nested.json',
  'container-object-move-nested-rotated.json',
  'layer-image-upload-replace.json',
  'layer-crossword-create.json',
  'artwork-editor-history-undo-redo.json',
  'artwork-editor-serialize-restore-normalized.json',
  'artwork-editor-serialize-restore-mixed-raw.json',
] as const;

const FAMILY_BY_FILE: Readonly<Record<string, string>> = {
  'layer-text-move-drag-ordinary.json': 'geometry-delta',
  'layer-text-move-drag-warped-nested.json': 'warped-text-envelope',
  'container-object-move-nested-rotated.json': 'nested-object-affine',
  'layer-image-upload-replace.json': 'image-upload-replace',
  'layer-crossword-create.json': 'crossword-determinism',
  'artwork-editor-history-undo-redo.json': 'history-cross-subject',
  'artwork-editor-serialize-restore-normalized.json': 'frontend-restore',
  'artwork-editor-serialize-restore-mixed-raw.json': 'frontend-restore',
};

describe('[P7-B2-D1] dispatch is by compiled evaluator discriminant + compatibility version', () => {
  it('exposes exactly the seven accepted dispatch entries, never keyed by Subject', () => {
    expect(FINAL_EVALUATOR_DISPATCH.map((entry) => entry.evaluatorKind)).toEqual([
      'geometry-delta',
      'warped-text-envelope',
      'nested-object-affine',
      'image-upload-replace',
      'crossword-determinism',
      'history-cross-subject',
      'frontend-restore',
    ]);
    const source = readFileSync(
      path.join(skillRoot, 'src/orchestration/diagnostic-execution.ts'),
      'utf8',
    );
    expect(source).not.toMatch(/subjectId\s*===/);
    expect(source).not.toContain('intent.scenario ===');
  });

  it('resolves all eight representative plans to their expected family path', () => {
    for (const fileName of REPRESENTATIVE_FILES) {
      const preparedCase = prepare(fileName);
      const entry = resolveFinalEvaluatorDispatch(
        preparedCase.profile.oracle.evaluatorKind,
        preparedCase.envelope.plan.route.adapterCompatibilityVersion,
      );
      expect(entry, fileName).not.toBeNull();
      expect(entry?.evaluatorKind, fileName).toBe(FAMILY_BY_FILE[fileName]);
    }
  });

  it('fails closed for an unknown discriminant or an unsupported compatibility version', () => {
    expect(resolveFinalEvaluatorDispatch('not-an-evaluator', 1)).toBeNull();
    expect(resolveFinalEvaluatorDispatch('geometry-delta', 99)).toBeNull();
    expect(resolveFinalEvaluatorDispatch('geometry-delta', 'three')).toBeNull();
  });
});

describe('[P7-B2-D1] all eight representative plans through all seven families', () => {
  it('executes every representative plan and assembles one strict v4 record', () => {
    const families = new Set<string>();
    for (const fileName of REPRESENTATIVE_FILES) {
      const preparedCase = prepare(fileName);
      const outcome = executeDiagnosticCase(baseInput(preparedCase));
      expect(
        outcome.issues,
        `${fileName}: ${outcome.issues.map((i) => i.code).join(', ')}`,
      ).toEqual([]);
      expect(outcome.evaluatorKind).toBe(FAMILY_BY_FILE[fileName]);
      expect(outcome.compatibilityVersion).toBe(
        preparedCase.envelope.plan.route.adapterCompatibilityVersion,
      );
      expect(outcome.launchAttempted).toBe(true);
      expect(outcome.record, fileName).not.toBeNull();
      expect(outcome.finalOutcome, fileName).toBe('HARNESS_BLOCKED');
      expect(outcome.behaviorOutcome, fileName).toBe('HARNESS_BLOCKED');
      expect(outcome.requiredChecks.map((check) => check.checkId)).toEqual(
        preparedCase.profile.requiredChecks.map((contract) => contract.checkId),
      );
      families.add(outcome.evaluatorKind as string);
    }
    expect([...families].sort()).toEqual([
      'crossword-determinism',
      'frontend-restore',
      'geometry-delta',
      'history-cross-subject',
      'image-upload-replace',
      'nested-object-affine',
      'warped-text-envelope',
    ]);
  });

  it('produces complete UNUSABLE authority for a delivered, missing-authority observation', () => {
    for (const fileName of REPRESENTATIVE_FILES) {
      const preparedCase = prepare(fileName);
      const outcome = executeDiagnosticCase(baseInput(preparedCase));
      expect(outcome.requiredChecks.length).toBe(preparedCase.profile.requiredChecks.length);
      expect(
        outcome.requiredChecks.every((check) => check.status === 'UNUSABLE'),
        fileName,
      ).toBe(true);
      expect(outcome.unusableCheckIds.length).toBe(outcome.requiredChecks.length);
      expect(outcome.failingCheckIds).toEqual([]);
    }
  });

  it('binds every produced check to the exact compiled profile and Action Cycle', () => {
    for (const fileName of REPRESENTATIVE_FILES) {
      const preparedCase = prepare(fileName);
      const outcome = executeDiagnosticCase(baseInput(preparedCase));
      const record = outcome.record;
      if (record === null) throw new Error(`${fileName} produced no record`);
      expect(record.schemaVersion).toBe(4);
      expect(record.planFingerprint).toBe(preparedCase.envelope.planFingerprint);
      expect(record.materializationFingerprint).toBe(
        preparedCase.envelope.materializationFingerprint,
      );
      expect(record.caseId).toBe(preparedCase.envelope.caseId);
      expect(record.resolvedProfileFingerprint).toBe(preparedCase.profile.resolvedFingerprint);
      expect(record.componentFingerprints).toEqual(preparedCase.profile.componentFingerprints);
      for (const check of record.requiredChecks) {
        expect(check.actionCycleRef).toBe(preparedCase.actionCycle.actionCycleId);
        expect(check.consumedComponentFingerprints.resolvedProfile).toBe(
          preparedCase.profile.resolvedFingerprint,
        );
        expect(Object.hasOwn(check, 'passed')).toBe(false);
        expect(Object.hasOwn(check, 'harnessInvalid')).toBe(false);
      }
      expect(Object.hasOwn(record, 'harnessInvalid')).toBe(false);
      expect(Object.isFrozen(record)).toBe(true);
      const stored = JSON.parse(JSON.stringify(record)) as unknown;
      expect(readFinalRecord(stored).kind).toBe('current-v4');
    }
  });

  it('carries the family check-bearing nested projection the current DTO requires', () => {
    const expected: Readonly<Record<string, readonly string[]>> = {
      'layer-text-move-drag-ordinary.json': ['action-cycle'],
      'layer-image-upload-replace.json': ['action-cycle', 'image'],
      'layer-crossword-create.json': ['action-cycle', 'crossword'],
      'artwork-editor-history-undo-redo.json': ['action-cycle', 'history'],
      'artwork-editor-serialize-restore-normalized.json': ['action-cycle', 'restore'],
    };
    for (const [fileName, families] of Object.entries(expected)) {
      const preparedCase = prepare(fileName);
      const outcome = executeDiagnosticCase(baseInput(preparedCase));
      const record = outcome.record;
      if (record === null) throw new Error(`${fileName} produced no record`);
      expect(record.nestedProjections.map((projection) => projection.family)).toEqual(families);
      const declared = preparedCase.profile.requiredChecks
        .map((contract) => contract.checkId)
        .sort();
      const nestedCheckIds: string[] = [];
      for (const projection of record.nestedProjections) {
        const value = projection as unknown as {
          readonly cycles?: readonly { readonly checks?: readonly { checkId: string }[] }[];
          readonly executions?: readonly { readonly checks?: readonly { checkId: string }[] }[];
          readonly checks?: readonly { checkId: string }[];
        };
        for (const cycle of value.cycles ?? []) {
          for (const check of cycle.checks ?? []) nestedCheckIds.push(check.checkId);
        }
        for (const execution of value.executions ?? []) {
          for (const check of execution.checks ?? []) nestedCheckIds.push(check.checkId);
        }
        for (const check of value.checks ?? []) nestedCheckIds.push(check.checkId);
      }
      if (families.length > 1) {
        expect([...new Set(nestedCheckIds)].sort(), fileName).toEqual(declared);
      }
    }
  });
});

describe('[P7-B2-D1] four-status boundaries', () => {
  it('classifies a trustworthy ordinary-Text match as PASS', () => {
    const preparedCase = prepare('layer-text-move-drag-ordinary.json');
    const checkId = preparedCase.profile.requiredChecks[0]?.checkId as string;
    const delta = projectOrdinaryTextLiveFact(
      evaluateGeometryDeltaOracle({
        minimumDelta: { x: 40, y: 20 },
        canonicalBefore: { x: 100, y: 100 },
        canonicalAfter: { x: 150, y: 130 },
        renderedBefore: { x: 100, y: 100 },
        renderedAfter: { x: 150, y: 130 },
      }),
    );
    const outcome = executeDiagnosticCase(
      baseInput(preparedCase, {
        observation: observationOf(preparedCase, {
          evaluatorKind: 'geometry-delta',
          projection: null,
          minimumDelta: { x: 40, y: 20 },
          delta: { ...delta, checkId },
          evidence: authoritativeEvidence(preparedCase.profile),
        }),
      }),
    );
    expect(outcome.issues).toEqual([]);
    expect(outcome.requiredChecks.every((check) => check.status === 'PASS')).toBe(true);
    expect(outcome.behaviorOutcome).toBe('PASS');
    expect(outcome.finalOutcome).toBe('PASS');
    expect(outcome.unusableCheckIds).toEqual([]);
    expect(outcome.failingCheckIds).toEqual([]);
    expect(outcome.record).not.toBeNull();
    expect(readFinalRecord(JSON.parse(JSON.stringify(outcome.record))).kind).toBe('current-v4');
  });

  it('classifies a trustworthy product mismatch as BUG with current authority', () => {
    const preparedCase = prepare('layer-text-move-drag-ordinary.json');
    const checkId = preparedCase.profile.requiredChecks[0]?.checkId as string;
    const delta = projectOrdinaryTextLiveFact(
      evaluateGeometryDeltaOracle({
        minimumDelta: { x: 40, y: 20 },
        canonicalBefore: { x: 100, y: 100 },
        canonicalAfter: { x: 105, y: 105 },
        renderedBefore: { x: 100, y: 100 },
        renderedAfter: { x: 105, y: 105 },
      }),
    );
    const outcome = executeDiagnosticCase(
      baseInput(preparedCase, {
        observation: observationOf(preparedCase, {
          evaluatorKind: 'geometry-delta',
          projection: null,
          minimumDelta: { x: 40, y: 20 },
          delta: { ...delta, checkId },
          evidence: authoritativeEvidence(preparedCase.profile),
        }),
      }),
    );
    expect(outcome.issues).toEqual([]);
    expect(outcome.requiredChecks.some((check) => check.status === 'FAIL')).toBe(true);
    expect(outcome.behaviorOutcome).toBe('BUG');
    expect(outcome.finalOutcome).toBe('BUG');
    expect(outcome.failingCheckIds.length).toBeGreaterThan(0);
  });

  it('classifies missing authority as HARNESS_BLOCKED', () => {
    const preparedCase = prepare('layer-text-move-drag-ordinary.json');
    const outcome = executeDiagnosticCase(baseInput(preparedCase));
    expect(outcome.behaviorOutcome).toBe('HARNESS_BLOCKED');
    expect(outcome.finalOutcome).toBe('HARNESS_BLOCKED');
  });

  it('preserves the behavior verdict when cleanup fails and only converts the final outcome', () => {
    const preparedCase = prepare('layer-text-move-drag-ordinary.json');
    const checkId = preparedCase.profile.requiredChecks[0]?.checkId as string;
    const delta = projectOrdinaryTextLiveFact(
      evaluateGeometryDeltaOracle({
        minimumDelta: { x: 40, y: 20 },
        canonicalBefore: { x: 100, y: 100 },
        canonicalAfter: { x: 150, y: 130 },
        renderedBefore: { x: 100, y: 100 },
        renderedAfter: { x: 150, y: 130 },
      }),
    );
    const outcome = executeDiagnosticCase(
      baseInput(preparedCase, {
        cleanupSucceeded: false,
        observation: observationOf(preparedCase, {
          evaluatorKind: 'geometry-delta',
          projection: null,
          minimumDelta: { x: 40, y: 20 },
          delta: { ...delta, checkId },
          evidence: authoritativeEvidence(preparedCase.profile),
        }),
      }),
    );
    expect(outcome.behaviorOutcome).toBe('PASS');
    expect(outcome.finalOutcome).toBe('ENVIRONMENT_FAILURE');
  });

  it('fabricates no check for an external pre-authority allocation failure', () => {
    const preparedCase = prepare('layer-text-move-drag-ordinary.json');
    const outcome = executeDiagnosticCase(
      baseInput(preparedCase, {
        prelaunch: { kind: 'allocation-failed', reason: 'PORT_UNAVAILABLE', detail: 'port busy' },
      }),
    );
    expect(outcome.finalOutcome).toBe('ENVIRONMENT_FAILURE');
    expect(outcome.behaviorOutcome).toBeNull();
    expect(outcome.launchAttempted).toBe(false);
    expect(outcome.requiredChecks).toEqual([]);
    expect(outcome.record).toBeNull();
    expect(outcome.issues.map((issue) => issue.code)).toContain('EXTERNAL_PREAUTHORITY_FAILURE');
  });

  it('fabricates no check for an external post-reservation failure', () => {
    const preparedCase = prepare('layer-text-move-drag-ordinary.json');
    const outcome = executeDiagnosticCase(baseInput(preparedCase, { externalFailure: true }));
    expect(outcome.finalOutcome).toBe('ENVIRONMENT_FAILURE');
    expect(outcome.behaviorOutcome).toBeNull();
    expect(outcome.requiredChecks).toEqual([]);
    expect(outcome.record).toBeNull();
  });
});

describe('[P7-B2-D1] preallocation and fail-closed boundaries', () => {
  it('fails an undelivered envelope preallocation with trustworthy planned identities and no record', () => {
    const preparedCase = prepare('layer-text-move-drag-ordinary.json');
    const undelivered: PlanForExecutionResult = { ...preparedCase.planning, envelope: null };
    const outcome = executeDiagnosticCase(baseInput(preparedCase, { planning: undelivered }));
    expect(outcome.finalOutcome).toBe('HARNESS_BLOCKED');
    expect(outcome.behaviorOutcome).toBeNull();
    expect(outcome.launchAttempted).toBe(false);
    expect(outcome.prelaunch).toBe(true);
    expect(outcome.caseId).toBe(preparedCase.planning.caseId);
    expect(outcome.materializationFingerprint).toBe(
      preparedCase.planning.materializationFingerprint,
    );
    expect(outcome.planFingerprint).toBe(preparedCase.planning.planFingerprint);
    expect(outcome.requiredChecks).toEqual([]);
    expect(outcome.record).toBeNull();
    expect(outcome.issues.map((issue) => issue.code)).toContain('ENVELOPE_UNDELIVERED');
  });

  it('passes a non-PLANNED planning projection through with no record', () => {
    const preparedCase = prepare('layer-text-move-drag-ordinary.json');
    const blocked = planCaseForExecution({ schemaVersion: 1 }, { catalogues: bundle });
    expect(blocked.status).toBe('HARNESS_BLOCKED');
    const outcome = executeDiagnosticCase(baseInput(preparedCase, { planning: blocked }));
    expect(outcome.finalOutcome).toBe('HARNESS_BLOCKED');
    expect(outcome.launchAttempted).toBe(false);
    expect(outcome.record).toBeNull();
    expect(outcome.issues.map((issue) => issue.code)).toContain('PLANNING_HARNESS_BLOCKED');
  });

  it('fails closed on a tampered envelope profile before any record', () => {
    const preparedCase = prepare('layer-text-move-drag-ordinary.json');
    const envelope = preparedCase.envelope as unknown as Record<string, unknown>;
    const profile = envelope.correctnessProfile as Record<string, unknown>;
    const tamperedEnvelope = {
      ...envelope,
      correctnessProfile: {
        ...profile,
        readiness: { ...(profile.readiness as object), deadlineMs: 1 },
      },
    } as unknown as MaterializedExecutionEnvelopeV1;
    const planning = { ...preparedCase.planning, envelope: tamperedEnvelope };
    const outcome = executeDiagnosticCase(
      baseInput(preparedCase, {
        planning,
        observation: {
          envelope: tamperedEnvelope,
          actionCycle: preparedCase.actionCycle,
          payload: noAuthorityPayload(preparedCase),
          observationId: 'b2d1-observation',
        },
      }),
    );
    expect(outcome.finalOutcome).toBe('HARNESS_BLOCKED');
    expect(outcome.record).toBeNull();
    expect(outcome.issues.map((issue) => issue.code)).toContain('ADAPTER_DISAGREEMENT');
    expect(outcome.launchAttempted).toBe(true);
    expect(outcome.prelaunch).toBe(false);
  });

  it('fails closed when the delivered observation discriminant contradicts the compiled one', () => {
    const preparedCase = prepare('layer-text-move-drag-ordinary.json');
    const mismatch = observationOf(
      preparedCase,
      noAuthorityPayload(prepare('layer-image-upload-replace.json')),
    );
    const outcome = executeDiagnosticCase(baseInput(preparedCase, { observation: mismatch }));
    expect(outcome.finalOutcome).toBe('HARNESS_BLOCKED');
    expect(outcome.record).toBeNull();
    expect(outcome.issues.map((issue) => issue.code)).toContain(
      'OBSERVATION_DISCRIMINANT_MISMATCH',
    );
  });

  it('fails closed on an unsupported compatibility version before any record', () => {
    const preparedCase = prepare('layer-text-move-drag-ordinary.json');
    const envelope = preparedCase.envelope as unknown as Record<string, unknown>;
    const plan = envelope.plan as Record<string, unknown>;
    const route = plan.route as Record<string, unknown>;
    const tamperedEnvelope = {
      ...envelope,
      plan: { ...plan, route: { ...route, adapterCompatibilityVersion: 99 } },
    } as unknown as MaterializedExecutionEnvelopeV1;
    const planning = { ...preparedCase.planning, envelope: tamperedEnvelope };
    const outcome = executeDiagnosticCase(baseInput(preparedCase, { planning }));
    expect(outcome.record).toBeNull();
    expect(outcome.issues.map((issue) => issue.code)).toContain(
      'DISPATCH_COMPATIBILITY_VERSION_UNSUPPORTED',
    );
  });

  it('declares a closed issue vocabulary', () => {
    expect(new Set(DIAGNOSTIC_EXECUTION_ISSUE_CODES).size).toBe(
      DIAGNOSTIC_EXECUTION_ISSUE_CODES.length,
    );
    expect(DIAGNOSTIC_EXECUTION_ISSUE_CODES).toContain('ENVELOPE_UNDELIVERED');
    expect(SUITE_AGGREGATION_ISSUE_CODES).toContain('SUITE_CHILD_LEGACY_RECORD');
  });
});

// ── Suite orchestration ──────────────────────────────────────────────────────

function suiteChildInput(
  fileName: string,
  order: number,
  overrides: Partial<SuiteChildExecutionInput> = {},
): SuiteChildExecutionInput {
  const preparedCase = prepare(fileName);
  return {
    ...baseInput(preparedCase),
    order,
    caseId: preparedCase.planning.caseId,
    request: `cases/diagnostic/requests/${fileName}`,
    expectedOutcome: 'PASS',
    ...overrides,
  };
}

function executeChildren(): SuiteChildOutcome[] {
  return REPRESENTATIVE_FILES.map((fileName, index) =>
    executeSuiteChild(suiteChildInput(fileName, index + 1)),
  );
}

describe('[P7-B2-D1] suite child execution and aggregation', () => {
  it('executes all eight children, each owning its own distinct envelope', () => {
    const children = executeChildren();
    expect(children).toHaveLength(8);
    const fingerprints = new Set(children.map((child) => child.envelope?.planFingerprint));
    expect(fingerprints.size).toBe(8);
    for (const child of children) {
      expect(child.envelope, String(child.order)).not.toBeNull();
      expect(child.identityAgrees).toBe(true);
      expect(child.execution.record).not.toBeNull();
    }
  });

  it('aggregates a complete suite preserving every child behavior and final verdict', () => {
    const children = executeChildren();
    const result = aggregateSuiteChildren({ declaredCaseCount: 8, children });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.decision.complete).toBe(true);
    expect(result.decision.finalStatus).toBe('HARNESS_BLOCKED');
    expect(result.decision.behaviorStatus).toBe('HARNESS_BLOCKED');
    expect(result.decision.pass).toBe(false);
    expect(result.decision.children).toHaveLength(8);
    expect(result.decision.children.map((child) => child.order)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    for (const [index, child] of result.decision.children.entries()) {
      const executed = children[index] as SuiteChildOutcome;
      expect(child.behaviorOutcome).toBe(executed.execution.behaviorOutcome);
      expect(child.finalOutcome).toBe(executed.execution.finalOutcome);
      expect(child.recordPresent).toBe(true);
    }
  });

  it('refuses a legacy, mixed, or incomplete child record', () => {
    const children = executeChildren();
    const base = children[0] as SuiteChildOutcome;

    const legacyRecord = {
      schemaVersion: 3,
      command: 'diagnostic',
      recordedAt: '2026-01-01T00:00:00.000Z',
      runId: 'legacy-run',
      caseId: base.caseId,
      materializationFingerprint: base.envelope?.materializationFingerprint,
      planFingerprint: base.envelope?.planFingerprint,
      requiredChecks: [{ checkId: 'geometry.delta', passed: true }],
    };
    const legacyChild: SuiteChildOutcome = {
      ...base,
      execution: { ...base.execution, record: legacyRecord as never },
    };
    const legacy = aggregateSuiteChildren({
      declaredCaseCount: 8,
      children: [legacyChild, ...children.slice(1)],
    });
    expect(legacy.ok).toBe(false);
    if (!legacy.ok)
      expect(legacy.issues.map((issue) => issue.code)).toContain('SUITE_CHILD_LEGACY_RECORD');

    const mixedRecord = JSON.parse(JSON.stringify(base.execution.record)) as Record<
      string,
      unknown
    >;
    (
      (mixedRecord.requiredChecks as Record<string, unknown>[])[0] as Record<string, unknown>
    ).passed = true;
    const mixedChild: SuiteChildOutcome = {
      ...base,
      execution: { ...base.execution, record: mixedRecord as never },
    };
    const mixed = aggregateSuiteChildren({
      declaredCaseCount: 8,
      children: [mixedChild, ...children.slice(1)],
    });
    expect(mixed.ok).toBe(false);
    if (!mixed.ok)
      expect(mixed.issues.map((issue) => issue.code)).toContain('SUITE_CHILD_MIXED_RECORD');

    const incompleteRecord = JSON.parse(JSON.stringify(children[2]?.execution.record)) as Record<
      string,
      unknown
    >;
    (incompleteRecord.requiredChecks as unknown[]).pop();
    const incompleteChild: SuiteChildOutcome = {
      ...(children[2] as SuiteChildOutcome),
      execution: {
        ...(children[2] as SuiteChildOutcome).execution,
        record: incompleteRecord as never,
      },
    };
    const incomplete = aggregateSuiteChildren({
      declaredCaseCount: 8,
      children: [
        children[0] as SuiteChildOutcome,
        children[1] as SuiteChildOutcome,
        incompleteChild,
        ...children.slice(3),
      ],
    });
    expect(incomplete.ok).toBe(false);
    if (!incomplete.ok)
      expect(incomplete.issues.map((issue) => issue.code)).toContain('SUITE_CHILD_INCOMPLETE');
  });

  it('refuses a child whose record identity disagrees with its own envelope', () => {
    const children = executeChildren();
    const base = children[0] as SuiteChildOutcome;
    const tampered = JSON.parse(JSON.stringify(base.execution.record)) as Record<string, unknown>;
    tampered.planFingerprint = 'a'.repeat(64);
    const child: SuiteChildOutcome = {
      ...base,
      execution: { ...base.execution, record: tampered as never },
    };
    const result = aggregateSuiteChildren({
      declaredCaseCount: 8,
      children: [child, ...children.slice(1)],
    });
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.issues.map((issue) => issue.code)).toContain('SUITE_MEMBER_IDENTITY_MISMATCH');
  });

  it('refuses a non-canonical order and a member-count mismatch', () => {
    const children = executeChildren();
    const reordered: SuiteChildOutcome[] = [
      { ...(children[0] as SuiteChildOutcome), order: 2 },
      ...children.slice(1),
    ];
    const orderResult = aggregateSuiteChildren({ declaredCaseCount: 8, children: reordered });
    expect(orderResult.ok).toBe(false);
    if (!orderResult.ok)
      expect(orderResult.issues.map((issue) => issue.code)).toContain('SUITE_ORDER_INVALID');

    const countResult = aggregateSuiteChildren({ declaredCaseCount: 9, children });
    expect(countResult.ok).toBe(false);
    if (!countResult.ok)
      expect(countResult.issues.map((issue) => issue.code)).toContain(
        'SUITE_MEMBER_COUNT_MISMATCH',
      );
  });

  it('preserves a mixed PASS/BLOCKED suite without reclassifying any child', () => {
    const preparedCase = prepare('layer-text-move-drag-ordinary.json');
    const checkId = preparedCase.profile.requiredChecks[0]?.checkId as string;
    const delta = projectOrdinaryTextLiveFact(
      evaluateGeometryDeltaOracle({
        minimumDelta: { x: 40, y: 20 },
        canonicalBefore: { x: 100, y: 100 },
        canonicalAfter: { x: 150, y: 130 },
        renderedBefore: { x: 100, y: 100 },
        renderedAfter: { x: 150, y: 130 },
      }),
    );
    const passChild = executeSuiteChild({
      ...baseInput(preparedCase, {
        observation: observationOf(preparedCase, {
          evaluatorKind: 'geometry-delta',
          projection: null,
          minimumDelta: { x: 40, y: 20 },
          delta: { ...delta, checkId },
          evidence: authoritativeEvidence(preparedCase.profile),
        }),
      }),
      order: 1,
      caseId: preparedCase.planning.caseId,
      request: 'cases/diagnostic/requests/layer-text-move-drag-ordinary.json',
      expectedOutcome: 'PASS',
    });
    const blockedChild = executeSuiteChild(
      suiteChildInput('layer-text-move-drag-warped-nested.json', 2),
    );
    const result = aggregateSuiteChildren({
      declaredCaseCount: 2,
      children: [passChild, blockedChild],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.decision.finalStatus).toBe('HARNESS_BLOCKED');
    expect(result.decision.behaviorStatus).toBe('HARNESS_BLOCKED');
    expect(result.decision.pass).toBe(false);
    const summaries = result.decision.children;
    expect(summaries[0]?.behaviorOutcome).toBe('PASS');
    expect(summaries[0]?.finalOutcome).toBe('PASS');
    expect(summaries[0]?.expectedMet).toBe(true);
    expect(summaries[1]?.behaviorOutcome).toBe('HARNESS_BLOCKED');
    expect(summaries[1]?.expectedMet).toBe(false);
  });

  it('raises an interrupted suite to ENVIRONMENT_FAILURE without rewriting children', () => {
    const children = executeChildren();
    const result = aggregateSuiteChildren({ declaredCaseCount: 8, children, interrupted: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.decision.finalStatus).toBe('ENVIRONMENT_FAILURE');
    expect(result.decision.behaviorStatus).toBe('HARNESS_BLOCKED');
    for (const child of children) {
      expect(child.execution.finalOutcome).toBe('HARNESS_BLOCKED');
    }
  });
});

describe('[P7-B2-D1] current import and write boundary', () => {
  const NEW_MODULES = [
    'src/orchestration/diagnostic-execution.ts',
    'src/orchestration/suite-execution.ts',
  ];

  function source(relative: string): string {
    return readFileSync(path.join(skillRoot, relative), 'utf8');
  }

  it('is reached only through the final façade, never directly by an executor, writer, reader, browser, or barrel module', () => {
    const markers = [
      'orchestration/diagnostic-execution',
      'orchestration/suite-execution',
      'executeDiagnosticCase',
      'executeSuiteChild',
      'aggregateSuiteChildren',
    ];
    // The current CLI entry reaches the orchestration through the final façade
    // only; it must never call an orchestration function itself, and no other
    // entry may reach suite orchestration at all.
    for (const relative of ['src/cli/diagnostic.ts', 'src/cli/suite.ts', 'src/cli/main.ts']) {
      const text = source(relative);
      for (const marker of markers) {
        if (relative === 'src/cli/diagnostic.ts' && marker === 'orchestration/diagnostic-execution')
          continue;
        expect(text, `module ${relative} references ${marker}`).not.toContain(marker);
      }
    }
    expect(source('src/cli/diagnostic.ts')).toContain(
      "import type { DiagnosticPrelaunchFacts } from '../orchestration/diagnostic-execution';",
    );
    for (const relative of [
      'src/runtime/execute-plan.ts',
      'src/runtime/action-cycle.ts',
      'src/runtime/outcomes.ts',
      'src/evidence/writer.ts',
      'src/evidence/reader.ts',
      'src/evidence/suite-record.ts',
      'src/browser/doctor.ts',
      'src/browser/production-absence.ts',
      'src/index.ts',
    ]) {
      const text = source(relative);
      for (const marker of markers) {
        expect(text, `module ${relative} references ${marker}`).not.toContain(marker);
      }
    }
  });

  it('never writes a record on the current evidence path and consumes the executor handoff as a type only', () => {
    for (const relative of NEW_MODULES) {
      const text = source(relative);
      expect(text, relative).not.toContain('node:fs');
      expect(text, relative).not.toContain('writePublicRunRecord');
      expect(text, relative).not.toContain('writePublicSuiteRecord');
      expect(text, relative).not.toContain('writeExclusiveRecordFile');
      expect(text, relative).not.toContain("from '../evidence/");
      expect(text, relative).not.toContain("from '../cli/");
      expect(text, relative).not.toContain('contracts/execution');
    }
    // ADR 0033: the orchestration consumes the executor-owned handoff by type
    // reference only, never by importing a runtime executor value.
    expect(source('src/orchestration/diagnostic-execution.ts')).toMatch(
      /import type \{[^}]*FinalExecutionObservation[^}]*\} from '\.\.\/runtime\/execute-plan';/,
    );
    expect(source('src/orchestration/suite-execution.ts')).not.toContain(
      "from '../runtime/execute-plan",
    );
  });

  it('never recompiles or reloads a profile or catalogue', () => {
    for (const relative of NEW_MODULES) {
      const text = source(relative);
      expect(text, relative).not.toContain('planCase(');
      expect(text, relative).not.toContain('loadCatalogueBundle');
      expect(text, relative).not.toContain('compilePlan');
      expect(text, relative).not.toContain('createMaterializedExecutionEnvelope');
    }
  });

  it('declares no Subject, family-name, or scenario dispatch policy', () => {
    for (const relative of NEW_MODULES) {
      const text = source(relative);
      expect(text, relative).not.toMatch(/subjectId\s*===/);
      expect(text, relative).not.toMatch(/'layer\/|'artwork\/|'container\//);
      expect(text, relative).not.toContain('scenario ===');
    }
  });

  it('retains the boolean/v3 baseline off the current path', () => {
    expect(source('src/contracts/execution.ts')).toMatch(
      /export interface CheckResult \{\n {2}checkId: string;\n {2}passed: boolean;\n\}/,
    );
    expect(source('src/contracts/schema-versions.ts')).toContain(
      'export const DIAGNOSTIC_RUN_RECORD_SCHEMA_VERSION = 3;',
    );
    expect(source('src/runtime/outcomes.ts')).toContain('harnessInvalid');
  });
});
