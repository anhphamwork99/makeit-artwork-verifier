import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  DOCTOR_COMMAND_AUTHORITY,
  DOCTOR_COMMAND_CHECKS,
  DOCTOR_COMMAND_DIAGNOSTIC_EVIDENCE,
  DOCTOR_COMMAND_REQUIRED_EVIDENCE,
  DOCTOR_COMMAND_STATUS_AUTHORITY,
  OBSERVATION_GLOBAL_MARKER,
  PRODUCTION_ABSENCE_COMMAND_AUTHORITY,
  PRODUCTION_ABSENCE_COMMAND_CHECKS,
  PRODUCTION_ABSENCE_COMMAND_DIAGNOSTIC_EVIDENCE,
  PRODUCTION_ABSENCE_COMMAND_REQUIRED_EVIDENCE,
  PRODUCTION_ABSENCE_COMMAND_STATUS_AUTHORITY,
  PRODUCTION_ABSENCE_ROUTE,
  WP5_COMPATIBILITY_ORACLE,
  auditWp5Compatibility,
  compileResolvedCorrectnessProfile,
  evaluateGeometryDeltaOracle,
  evaluateProductionAbsence,
  evaluateProductionBrowserAbsence,
  loadCorrectnessCatalogue,
  resolveRouteSelection,
  scanArtifactContent,
} from '../../src/index';
import type {
  CommandCheckFact,
  CommandEvidenceAvailability,
  CommandEvidenceFact,
  CommandStatusAuthority,
  ProductionBrowserObservation,
} from '../../src/index';
import { compatibilityProjectionOfCompiledProfile } from '../../src/catalogue/correctness-compatibility';
import { loadCatalogueBundle, type CatalogueBundle } from '../../src/catalogue/load';
import { loadDiagnosticSuite, resolveSuiteRequests } from '../../src/catalogue/suite';
import type {
  ActionCycleCorrectnessIdentity,
  CorrectnessCheckResult,
  ResolvedCorrectnessProfile,
} from '../../src/contracts/correctness';
import type { Capability } from '../../src/contracts/discriminants';
import {
  assembleFinalChildRecordV4,
  type AssembleFinalChildRecordV4Input,
  type FinalNestedProjectionV4,
} from '../../src/contracts/final-record-v4';
import { readFinalRecord } from '../../src/contracts/final-record-reader';
import { CHECK_RESULT_CONTRACT_SCHEMA_VERSION } from '../../src/contracts/schema-versions';
import {
  MATERIALIZED_EXECUTION_ENVELOPE_SCHEMA_VERSION,
  validateMaterializedExecutionEnvelope,
  type MaterializedExecutionEnvelopeV1,
} from '../../src/planner/execution-materialization';
import {
  planCase,
  planCaseForExecution,
  type PlanForExecutionResult,
} from '../../src/planner/plan-case';
import { resolveToolkitRoot } from '../../src/runtime/paths';
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
import {
  COMMAND_EXECUTION_ISSUE_CODES,
  validateCommandExecutionChecks,
  type CommandExecutionOutcome,
} from '../../src/orchestration/command-execution';
import { executeDoctorCommandContext } from '../../src/orchestration/doctor-command-execution';
import { executeProductionAbsenceCommandContext } from '../../src/orchestration/production-absence-command-execution';
import {
  evaluateOrdinaryTextLiveChecks,
  evaluateWarpedTextLiveChecks,
  projectOrdinaryTextLiveFact,
} from '../../src/adapters/text-live-facts';
import { evaluateNestedObjectLiveChecks } from '../../src/adapters/object-live-facts';
import { evaluateImageLiveChecks } from '../../src/adapters/image-live-facts';
import { evaluateCrosswordLiveChecks } from '../../src/adapters/crossword-live-facts';
import { evaluateHistoryLiveChecks } from '../../src/adapters/history-live-facts';
import { evaluateRestoreLiveChecks } from '../../src/adapters/restore-live-facts';

/**
 * P7-B2 joint pre-activation proof (ADR 0029 §4, B2-B through B2-D joint gate).
 *
 * One focused foundation suite that drives the *real* `planCaseForExecution`
 * envelopes for all eight representative requests through every inactive B2
 * surface together: the seven per-family live-fact adapters and kernels, the
 * strict-v4 assembler and reader, the representative Diagnostic/suite
 * orchestration, and the Doctor/production-absence command orchestration.
 *
 * It also proves the static boundaries the joint gate names: no adapter owns
 * policy, no final status translates a legacy `passed`/`status`/`harnessInvalid`,
 * exact evidence/component identities, legacy `false` ambiguity, undelivered /
 * pre-authority fail-closed behavior, no import by an active writer/reader/
 * CLI/executor, the frozen active boolean/v3 baseline, and a static
 * inventory/count of the eventual B2-E activation targets.
 *
 * Nothing here is active: the envelope is never wired into an active executor,
 * writer, reader, classifier, or CLI, and no accepted run/suite evidence is
 * produced.
 */

const skillRoot = resolveToolkitRoot();
const bundle: CatalogueBundle = loadCatalogueBundle();
const resolvedRequests = resolveSuiteRequests(loadDiagnosticSuite('representative'));

interface AcceptedPlanIdentity {
  requestFile: string;
  caseId: string;
  materializationFingerprint: string;
  planFingerprint: string;
  profileId: string;
  correctnessProfileFingerprint: string;
  requiredChecks: readonly string[];
}

/** Accepted B1 representative plan identities; the joint proof must not move any. */
const ACCEPTED_B1_PLANS: readonly AcceptedPlanIdentity[] = [
  {
    requestFile: 'layer-text-move-drag-ordinary.json',
    caseId: '506afaa6864d5230947582e74bf7d38ef65fa1bada1a2b888edbb28680714096',
    materializationFingerprint: 'dcea52524dbc361321f748ffe8b5d27d6ef2b8d8fc6308e4b539231b83b0b868',
    planFingerprint: '0c1d35d8248c9e1c2766f7c6e4836af2f853b30887e38a43f4a233641a570f55',
    profileId: 'action-cycle-v1',
    correctnessProfileFingerprint:
      '1badcb82499bedbb3e912b415dfd84f0f37654d1903d8fdd7a77e174faaec3ad',
    requiredChecks: ['geometry.delta'],
  },
  {
    requestFile: 'layer-text-move-drag-warped-nested.json',
    caseId: 'bb3c9f9349a70a968dec453e18c9602faef15fcee4c4ba1bca035dc1dff54274',
    materializationFingerprint: '78372bc710e51e9506ed0967e5972f10ec653d3f84dece3ec88bc7fbaa0b24ba',
    planFingerprint: '31bf3e4a725d1b4218076223fc8cd9814ed10b09dd93b92a89b40b634fa05154',
    profileId: 'warped-text-action-cycle-v1',
    correctnessProfileFingerprint:
      'd8257582ee954466b761eee789b18939fffdc64223c28765d8b859b8619d5506',
    requiredChecks: ['geometry.delta', 'geometry.warp-envelope'],
  },
  {
    requestFile: 'layer-image-upload-replace.json',
    caseId: '7f8aee1166fc1e111f9178e7ed38a2d83669e15653f4616e0c284899e59f55c9',
    materializationFingerprint: 'f650c5def85b31ccc4d470d3580ed50cc2fc1958dcac93dd28fdb213ed6e5845',
    planFingerprint: '0e6a22756698898b069858ae918bb8c38efbbaad4af8d029dac860527d4d34f9',
    profileId: 'image-raster-action-cycle-v1',
    correctnessProfileFingerprint:
      '144fa9c0e3f5207da2fb38d911d2a318339f8b2331904b7ab1cb941618c6c0a3',
    requiredChecks: [
      'image.content-distinct',
      'image.frame-stable',
      'image.raster-current',
      'image.semantic-transition',
      'image.structural-visual',
    ],
  },
  {
    requestFile: 'container-object-move-nested-rotated.json',
    caseId: '69d91a528e7ceab705be5a92093b89d477c43b2e4fb785502996ceb5cb9f730a',
    materializationFingerprint: 'e677cfed5c36b3bc5d9af3da4502b7b1e214a7b5d333da9b23b43476a81dddef',
    planFingerprint: '3241c27ae71e3671b0d6cdcaf305123b387380880f876383fca7d3ddcbd9205c',
    profileId: 'nested-object-action-cycle-v1',
    correctnessProfileFingerprint:
      '5ba5eed193d951adf1c3f1376976ab44f4266a0d8c5705fd2633bb51e0bd23c6',
    requiredChecks: [
      'containment.parent-chain',
      'geometry.delta',
      'geometry.local-invariant',
      'geometry.world-composition',
    ],
  },
  {
    requestFile: 'layer-crossword-create.json',
    caseId: '243cb9c1d7edc26e64d5afcfda221d28bd59dfdc68a20d123d6fc781fe512f84',
    materializationFingerprint: 'a68acaac8fa46578f89202cae78126ce4bd1bb911cdde92379501e39ba2b576c',
    planFingerprint: '804c874be43c18b8c2666522495718ec2a58ff0c4f90483ea70453a277711162',
    profileId: 'crossword-generation-action-cycle-v1',
    correctnessProfileFingerprint:
      '29767ef2f70dc30a85431e1dc36c8551424aa5ed4fff45f6eb81b9219a7bb410',
    requiredChecks: [
      'crossword.created',
      'crossword.different-seed-sensitive',
      'crossword.raster-current',
      'crossword.same-seed-repeatable',
      'crossword.seed-derived',
      'crossword.semantic-valid',
    ],
  },
  {
    requestFile: 'artwork-editor-history-undo-redo.json',
    caseId: '76eadd5ad7b6c06eee55db07e455e45f0b1567fb7af6443319d7aacb5c6d9262',
    materializationFingerprint: '46d651a40357d8978fa7b85dca3429092feb763f892d21f108cdcafe273c320a',
    planFingerprint: 'd8a6b317900730171188fdceaf7b825cf17e793cde1b3de86d6ca6b2e95cc7dc',
    profileId: 'history-transition-v1',
    correctnessProfileFingerprint:
      '63ace6473ff0a606e06a5e992c5265d30f9574be5108327a7fb3e063b940b2ab',
    requiredChecks: ['history.depth', 'history.meaning'],
  },
  {
    requestFile: 'artwork-editor-serialize-restore-normalized.json',
    caseId: 'b0f3d39b062182ec96e4ab97b1202dbc89b16a892acc34ee39d22a39cb23af67',
    materializationFingerprint: '98ad2995199692565a4bc33dc3880e76d6bf5b0fa5a5388e2c63fa8c0ec342cd',
    planFingerprint: '798801eba87d9d24e9ccb88503801d3753915efb5b6ecb0a73777c95ca4bf6f9',
    profileId: 'frontend-restore-transition-v1',
    correctnessProfileFingerprint:
      '4cd3d3164eff0ecacbdd7db1740a3bc523730c92de51d02bc2dc06518a6306fe',
    requiredChecks: ['serialize.raw-semantic', 'serialize.roundtrip'],
  },
  {
    requestFile: 'artwork-editor-serialize-restore-mixed-raw.json',
    caseId: 'c19b842f8b1018cca03db845673acba86e750be755e5d76e2a7ef3f25701ad86',
    materializationFingerprint: 'b5317feacc8a09b5d232a78c6250a1df4e5de032f370de132e306f52fd8bb4f1',
    planFingerprint: '269ccf9aff67c044416fb5ec2ed82f507e14bbe8e3ba3b03bbe6b8184d1ad6f1',
    profileId: 'frontend-restore-transition-v1',
    correctnessProfileFingerprint:
      '4cd3d3164eff0ecacbdd7db1740a3bc523730c92de51d02bc2dc06518a6306fe',
    requiredChecks: ['serialize.raw-semantic', 'serialize.roundtrip'],
  },
];

const REPRESENTATIVE_FILES = ACCEPTED_B1_PLANS.map((plan) => plan.requestFile);

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

function representativeRequest(fileName: string): unknown {
  const entry = resolvedRequests.find(
    (candidate) => path.basename(candidate.relativePath) === fileName,
  );
  if (entry === undefined) throw new Error(`missing representative request ${fileName}`);
  return entry.request;
}

interface PreparedCase {
  readonly fileName: string;
  readonly baseline: AcceptedPlanIdentity;
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

function baselineFor(fileName: string): AcceptedPlanIdentity {
  const found = ACCEPTED_B1_PLANS.find((plan) => plan.requestFile === fileName);
  if (found === undefined) throw new Error(`no accepted baseline for ${fileName}`);
  return found;
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
    baseline: baselineFor(fileName),
    planning,
    envelope,
    profile,
    route: { subjectId: intent.subjectId, capability: intent.capability, variant: intent.variant },
    actionCycle: {
      schemaVersion: CHECK_RESULT_CONTRACT_SCHEMA_VERSION,
      actionCycleId: `b2joint-cycle-${fileName}`,
      resolvedProfileFingerprint: profile.resolvedFingerprint,
      readinessFingerprint: profile.componentFingerprints.readiness,
    },
  };
}

const preparedCases: readonly PreparedCase[] = REPRESENTATIVE_FILES.map((fileName) =>
  prepare(fileName),
);

function expectDeeplyFrozen(value: unknown, seen = new Set<unknown>()): void {
  if (value === null || typeof value !== 'object') return;
  if (seen.has(value)) return;
  seen.add(value);
  expect(Object.isFrozen(value)).toBe(true);
  if (Array.isArray(value)) {
    for (const entry of value) expectDeeplyFrozen(entry, seen);
    return;
  }
  for (const entry of Object.values(value as Record<string, unknown>)) {
    expectDeeplyFrozen(entry, seen);
  }
}

function detailIssues(result: { ok: boolean; issues?: readonly { code: string }[] }): string[] {
  return result.ok ? [] : (result.issues ?? []).map((issue) => issue.code);
}

// ── Joint surface: exact envelopes ───────────────────────────────────────────

describe('[P7-B2 joint preactivation] eight representative planCaseForExecution envelopes', () => {
  it('delivers one exact, validated, deeply immutable envelope per representative request', () => {
    expect(preparedCases).toHaveLength(8);
    for (const prepared of preparedCases) {
      const { baseline, envelope } = prepared;
      expect(envelope.schemaVersion).toBe(MATERIALIZED_EXECUTION_ENVELOPE_SCHEMA_VERSION);
      expect(envelope.caseId).toBe(baseline.caseId);
      expect(envelope.materializationFingerprint).toBe(baseline.materializationFingerprint);
      expect(envelope.planFingerprint).toBe(baseline.planFingerprint);
      expect(envelope.correctnessProfile.profileId).toBe(baseline.profileId);
      expect(envelope.correctnessProfile.resolvedFingerprint).toBe(
        baseline.correctnessProfileFingerprint,
      );
      expect(
        validateMaterializedExecutionEnvelope({
          envelope,
          materializedCase: prepared.planning.materializedCase,
        }),
      ).toEqual({ ok: true });
      expectDeeplyFrozen(envelope);
    }
  });

  it('preserves every accepted B1 plan identity and required-check set exactly', () => {
    for (const prepared of preparedCases) {
      const { baseline, planning } = prepared;
      expect(planning.planFingerprint).toBe(baseline.planFingerprint);
      expect(planning.materializationFingerprint).toBe(baseline.materializationFingerprint);
      expect(planning.caseId).toBe(baseline.caseId);
      expect(planning.plan.requiredChecks).toEqual(baseline.requiredChecks);
      // The public projection is unchanged: the envelope is never a public field.
      const publicResult = planCase(representativeRequest(prepared.fileName), {
        catalogues: bundle,
      });
      expect(publicResult.status).toBe('PLANNED');
      if (publicResult.status !== 'PLANNED') continue;
      expect('envelope' in publicResult).toBe(false);
      const { envelope: _envelope, ...projection } = planning;
      expect(projection).toEqual(publicResult);
    }
  });
});

// ── Joint surface: seven families through the adapters/kernels ───────────────

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

function checksOf(outcome: {
  ok: boolean;
  result?: { checks: readonly CorrectnessCheckResult[] };
}): readonly CorrectnessCheckResult[] {
  if (!outcome.ok || outcome.result === undefined) throw new Error('family adapter failed');
  return outcome.result.checks;
}

interface FamilyProof {
  readonly family: string;
  readonly prepared: PreparedCase;
  readonly checks: readonly CorrectnessCheckResult[];
}

function buildFamilyProofs(): FamilyProof[] {
  const byFile = new Map(preparedCases.map((prepared) => [prepared.fileName, prepared]));
  const get = (fileName: string): PreparedCase => {
    const value = byFile.get(fileName);
    if (value === undefined) throw new Error(`missing prepared case ${fileName}`);
    return value;
  };
  const ordinary = get('layer-text-move-drag-ordinary.json');
  const warped = get('layer-text-move-drag-warped-nested.json');
  const nested = get('container-object-move-nested-rotated.json');
  const image = get('layer-image-upload-replace.json');
  const crossword = get('layer-crossword-create.json');
  const history = get('artwork-editor-history-undo-redo.json');
  const restore = get('artwork-editor-serialize-restore-normalized.json');

  return [
    {
      family: 'text-ordinary',
      prepared: ordinary,
      checks: checksOf(
        evaluateOrdinaryTextLiveChecks({
          envelope: ordinary.envelope,
          route: ordinary.route,
          actionCycle: ordinary.actionCycle,
          minimumDelta: null,
          delta: null,
          evidence: [],
        }),
      ),
    },
    {
      family: 'text-warped',
      prepared: warped,
      checks: checksOf(
        evaluateWarpedTextLiveChecks({
          envelope: warped.envelope,
          route: warped.route,
          actionCycle: warped.actionCycle,
          minimumDelta: null,
          oracle: null,
          evidence: [],
        }),
      ),
    },
    {
      family: 'nested-object',
      prepared: nested,
      checks: checksOf(
        evaluateNestedObjectLiveChecks({
          envelope: nested.envelope,
          route: nested.route,
          actionCycle: nested.actionCycle,
          minimumDelta: null,
          oracle: null,
          evidence: [],
        }),
      ),
    },
    {
      family: 'image',
      prepared: image,
      checks: checksOf(
        evaluateImageLiveChecks({
          envelope: image.envelope,
          route: image.route,
          actionCycle: image.actionCycle,
          mode: 'upload',
          targetId: 'b2joint-image-target',
          expectedLayoutId: 'b2joint-image-layout',
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
          readiness: readinessPolicy(image.profile) as never,
          evidence: [],
        }),
      ),
    },
    {
      family: 'crossword',
      prepared: crossword,
      checks: checksOf(
        evaluateCrosswordLiveChecks({
          envelope: crossword.envelope,
          route: crossword.route,
          actionCycle: crossword.actionCycle,
          clock: null,
          sourceFingerprintExpected: '',
          executions: [],
          oracle: null,
          evidence: [],
        }),
      ),
    },
    {
      family: 'history',
      prepared: history,
      checks: checksOf(
        evaluateHistoryLiveChecks({
          envelope: history.envelope,
          route: history.route,
          actionCycle: history.actionCycle,
          retainedLayoutId: null,
          setup: [],
          actions: [],
          finalHistory: null,
          readiness: readinessPolicy(history.profile) as never,
          oracle: null,
          evidence: [],
        }),
      ),
    },
    {
      family: 'restore',
      prepared: restore,
      checks: checksOf(
        evaluateRestoreLiveChecks({
          envelope: restore.envelope,
          route: restore.route,
          actionCycle: restore.actionCycle,
          schemaVersion: 1,
          transition: {},
          meaning: {},
          rawSemantics: {},
          source: null,
          restored: null,
          setup: [],
          readiness: readinessPolicy(restore.profile) as never,
          oracle: null,
          evidence: [],
        }),
      ),
    },
  ];
}

function actionCycleProjection(prepared: PreparedCase): FinalNestedProjectionV4 {
  const { profile, actionCycle } = prepared;
  return {
    schemaVersion: 4,
    family: 'action-cycle',
    actionCycles: [actionCycle],
    readiness: {
      profileId: profile.readiness.profileId,
      timingCategory: profile.readiness.deadlineCategory,
      deadlineMs: profile.readiness.deadlineMs,
      signalWatchdogMs: profile.readiness.signalWatchdogMs,
      stableFrames: profile.readiness.stableFrames,
    },
  };
}

function nestedProjectionsFor(
  proof: FamilyProof,
  checks: readonly CorrectnessCheckResult[],
): FinalNestedProjectionV4[] {
  const { prepared } = proof;
  const actionCycle = prepared.actionCycle;
  const projections: FinalNestedProjectionV4[] = [actionCycleProjection(prepared)];
  if (proof.family === 'image') {
    projections.push({
      schemaVersion: 4,
      family: 'image',
      cycles: [
        {
          checkpoint: 'after-upload-current',
          mode: 'upload',
          outcome: 'HARNESS_BLOCKED',
          observationId: null,
          tornRecaptureCount: 0,
          actionCycleRef: actionCycle.actionCycleId,
          checks,
        },
      ],
    });
  } else if (proof.family === 'crossword') {
    projections.push({
      schemaVersion: 4,
      family: 'crossword',
      providerId: 'playwright-clock-fixed-wall-v1',
      namespace: 'crossword.create.date-now.v1',
      comparisonProfileId: 'crossword-determinism-comparison-v1',
      executions: (['A1', 'A2', 'B'] as const).map((executionRole) => ({
        executionRole,
        clockBaselineUtc: '2026-01-01T00:00:00.000Z',
        expectedSeed: 1,
        actualSeed: 1,
        hostLayoutId: 'b2joint-crossword-host',
        createdTargetId: 'b2joint-crossword-target',
        words: [],
        semanticDigest: '0'.repeat(64),
        actionCycleRef: actionCycle.actionCycleId,
        checks,
      })),
      comparison: {
        sameSeedEqual: true,
        sameWordsEqual: true,
        sameSemanticDigestEqual: true,
        controlSeedDifferent: false,
        controlWordsEqual: true,
        controlSemanticDigestDifferent: false,
      },
    });
  } else if (proof.family === 'history') {
    projections.push({
      schemaVersion: 4,
      family: 'history',
      normalizationProfileId: 'artwork-product-meaning-v1',
      readinessProfileId: prepared.profile.readiness.profileId,
      oracleProfileId: prepared.profile.oracle.oracleProfileId,
      timingCategory: prepared.profile.readiness.deadlineCategory,
      deadlineMs: prepared.profile.readiness.deadlineMs,
      retainedLayoutId: 'b2joint-history-layout',
      finalHistory: { pastDepth: 0, futureDepth: 0, baselineClean: true },
      actionCycleRef: actionCycle.actionCycleId,
      checks,
    });
  } else if (proof.family === 'restore') {
    projections.push({
      schemaVersion: 4,
      family: 'restore',
      normalizationProfileId: 'artwork-product-meaning-v1',
      readinessProfileId: prepared.profile.readiness.profileId,
      oracleProfileId: prepared.profile.oracle.oracleProfileId,
      timingCategory: prepared.profile.readiness.deadlineCategory,
      deadlineMs: prepared.profile.readiness.deadlineMs,
      scenarioId: 'serialize-roundtrip',
      sourceDocumentId: 'b2joint-restore-source',
      restoredDocumentId: 'b2joint-restore-restored',
      actionCycleRef: actionCycle.actionCycleId,
      checks,
    });
  }
  return projections;
}

function assemblyInput(
  proof: FamilyProof,
  overrides: Partial<AssembleFinalChildRecordV4Input> = {},
): AssembleFinalChildRecordV4Input {
  return {
    envelope: proof.prepared.envelope,
    runId: `b2joint-run-${proof.family}`,
    observationId: null,
    actionCycles: [proof.prepared.actionCycle],
    requiredChecks: proof.checks,
    nestedProjections: nestedProjectionsFor(proof, proof.checks),
    ...overrides,
  };
}

describe('[P7-B2 joint preactivation] seven families: adapters → strict v4 → reader', () => {
  const proofs = buildFamilyProofs();

  it('exposes exactly the seven accepted evaluator families', () => {
    expect(proofs.map((proof) => proof.family)).toEqual([
      'text-ordinary',
      'text-warped',
      'nested-object',
      'image',
      'crossword',
      'history',
      'restore',
    ]);
  });

  it('assembles one strict v4 record per family and reads each back as current', () => {
    for (const proof of proofs) {
      const assembled = assembleFinalChildRecordV4(assemblyInput(proof));
      expect(assembled.ok, `${proof.family}: ${detailIssues(assembled).join(', ')}`).toBe(true);
      if (!assembled.ok) continue;
      const record = assembled.record;
      expect(record.resolvedProfileFingerprint).toBe(proof.prepared.profile.resolvedFingerprint);
      expect(record.componentFingerprints).toEqual(proof.prepared.profile.componentFingerprints);
      expect(record.requiredChecks.map((check) => check.checkId)).toEqual(
        proof.prepared.profile.requiredChecks.map((contract) => contract.checkId),
      );
      const stored = JSON.parse(JSON.stringify(record)) as unknown;
      const read = readFinalRecord(stored);
      expect(read.kind, proof.family).toBe('current-v4');
      if (read.kind !== 'current-v4') continue;
      expect(read.current).toBe(true);
      expect(read.legacy).toBe(false);
      expect(read.ambiguous).toBe(false);
      expect(read.record).toEqual(record);
    }
  });

  it('binds every required check to the exact compiled evidence and component identities', () => {
    for (const proof of proofs) {
      const assembled = assembleFinalChildRecordV4(assemblyInput(proof));
      if (!assembled.ok) throw new Error(`${proof.family} did not assemble`);
      const declaredEvidence = new Set(proof.prepared.profile.requiredAuthoritativeEvidence);
      const components = proof.prepared.profile.componentFingerprints as unknown as Record<
        string,
        string
      >;
      for (const check of assembled.record.requiredChecks) {
        const consumed = check.consumedComponentFingerprints as unknown as Record<string, string>;
        expect(consumed.resolvedProfile, proof.family).toBe(
          proof.prepared.profile.resolvedFingerprint,
        );
        for (const [field, value] of Object.entries(consumed)) {
          if (field === 'resolvedProfile') continue;
          expect(value, `${proof.family}:${field}`).toBe(components[field]);
        }
        expect(check.actionCycleRef).toBe(proof.prepared.actionCycle.actionCycleId);
        for (const evidenceId of check.evidenceIds) {
          expect(declaredEvidence.has(evidenceId), `${proof.family}:${evidenceId}`).toBe(true);
        }
        // No legacy boolean/aggregate authority on any produced check.
        expect(Object.hasOwn(check, 'passed')).toBe(false);
        expect(Object.hasOwn(check, 'harnessInvalid')).toBe(false);
      }
      expect(Object.hasOwn(assembled.record, 'harnessInvalid')).toBe(false);
    }
  });

  it('produces a strict PASS record from the real ordinary-Text oracle', () => {
    const ordinary = proofs.find((proof) => proof.family === 'text-ordinary') as FamilyProof;
    const prepared = ordinary.prepared;
    const checkId = prepared.profile.requiredChecks[0]?.checkId as string;
    const outcome = evaluateOrdinaryTextLiveChecks({
      envelope: prepared.envelope,
      route: prepared.route,
      actionCycle: prepared.actionCycle,
      minimumDelta: { x: 40, y: 20 },
      delta: projectOrdinaryTextLiveFact(
        evaluateGeometryDeltaOracle({
          minimumDelta: { x: 40, y: 20 },
          canonicalBefore: { x: 100, y: 100 },
          canonicalAfter: { x: 150, y: 130 },
          renderedBefore: { x: 100, y: 100 },
          renderedAfter: { x: 150, y: 130 },
        }),
      ),
      evidence: prepared.profile.requiredAuthoritativeEvidence.map((evidenceId) => ({
        evidenceId,
        availability: 'authoritative' as const,
      })),
    });
    if (!outcome.ok) throw new Error('expected the ordinary-Text adapter to succeed');
    expect(outcome.result.checks.map((check) => check.checkId)).toEqual([checkId]);
    expect(outcome.result.checks.every((check) => check.status === 'PASS')).toBe(true);
    const assembled = assembleFinalChildRecordV4({
      envelope: prepared.envelope,
      runId: 'b2joint-run-text-pass',
      observationId: 'b2joint-observation',
      actionCycles: [prepared.actionCycle],
      requiredChecks: outcome.result.checks,
      nestedProjections: [actionCycleProjection(prepared)],
    });
    expect(assembled.ok, detailIssues(assembled).join(', ')).toBe(true);
  });
});

// ── Joint surface: Diagnostic orchestration across all seven families ────────

function noAuthorityPayload(prepared: PreparedCase): FinalExecutionPayload {
  const kind = prepared.profile.oracle.evaluatorKind;
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
        projection: {
          schemaVersion: 4 as const,
          family: 'image' as const,
          cycles: [
            {
              checkpoint: 'after-upload-current',
              mode: 'upload',
              outcome: 'HARNESS_BLOCKED',
              observationId: null,
              tornRecaptureCount: 0,
              actionCycleRef: prepared.actionCycle.actionCycleId,
            },
          ],
        },
        mode: 'upload',
        targetId: 'b2joint-image-target',
        expectedLayoutId: 'b2joint-image-layout',
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
        readiness: readinessPolicy(prepared.profile) as never,
        evidence: [],
      };
    case 'crossword-determinism':
      return {
        evaluatorKind: 'crossword-determinism',
        projection: {
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
            hostLayoutId: 'b2joint-crossword-host',
            createdTargetId: 'b2joint-crossword-target',
            words: [],
            semanticDigest: '0'.repeat(64),
            actionCycleRef: prepared.actionCycle.actionCycleId,
          })),
          comparison: {
            sameSeedEqual: true,
            sameWordsEqual: true,
            sameSemanticDigestEqual: true,
            controlSeedDifferent: false,
            controlWordsEqual: true,
            controlSemanticDigestDifferent: false,
          },
        },
        clock: null,
        sourceFingerprintExpected: '',
        executions: [],
        oracle: null,
        evidence: [],
      };
    case 'history-cross-subject':
      return {
        evaluatorKind: 'history-cross-subject',
        projection: {
          schemaVersion: 4 as const,
          family: 'history' as const,
          normalizationProfileId: 'artwork-product-meaning-v1',
          readinessProfileId: prepared.profile.readiness.profileId,
          oracleProfileId: prepared.profile.oracle.oracleProfileId,
          timingCategory: prepared.profile.readiness.deadlineCategory,
          deadlineMs: prepared.profile.readiness.deadlineMs,
          retainedLayoutId: 'b2joint-history-layout',
          finalHistory: { pastDepth: 0, futureDepth: 0, baselineClean: true },
          actionCycleRef: prepared.actionCycle.actionCycleId,
        },
        retainedLayoutId: null,
        setup: [],
        actions: [],
        finalHistory: null,
        readiness: readinessPolicy(prepared.profile) as never,
        oracle: null,
        evidence: [],
      };
    case 'frontend-restore':
      return {
        evaluatorKind: 'frontend-restore',
        projection: {
          schemaVersion: 4 as const,
          family: 'restore' as const,
          normalizationProfileId: 'artwork-normalized-meaning-v1',
          readinessProfileId: prepared.profile.readiness.profileId,
          oracleProfileId: prepared.profile.oracle.oracleProfileId,
          timingCategory: prepared.profile.readiness.deadlineCategory,
          deadlineMs: prepared.profile.readiness.deadlineMs,
          scenarioId: 'serialize-roundtrip',
          sourceDocumentId: 'b2joint-restore-source',
          restoredDocumentId: 'b2joint-restore-restored',
          actionCycleRef: prepared.actionCycle.actionCycleId,
        },
        schemaVersion: 1,
        transition: {},
        meaning: {},
        rawSemantics: {},
        source: null,
        restored: null,
        setup: [],
        readiness: readinessPolicy(prepared.profile) as never,
        oracle: null,
        evidence: [],
      };
  }
}

/** Wraps one executor family payload in the exact envelope-bound handoff. */
function observationOf(
  prepared: PreparedCase,
  payload: FinalExecutionPayload,
): DiagnosticExecutionInput['observation'] {
  return {
    envelope: prepared.envelope,
    actionCycle: prepared.actionCycle,
    payload,
    observationId: 'b2joint-observation',
  };
}

function diagnosticInput(
  prepared: PreparedCase,
  overrides: Partial<DiagnosticExecutionInput> = {},
): DiagnosticExecutionInput {
  return {
    planning: prepared.planning,
    prelaunch: {
      kind: 'reserved',
      allocationId: 'b2joint-allocation',
      executionInstanceId: 'b2joint-instance',
    },
    observation: observationOf(prepared, noAuthorityPayload(prepared)),
    runId: `b2joint-run-${prepared.fileName}`,
    cleanupSucceeded: true,
    ...overrides,
  };
}

function authoritativeEvidence(profile: ResolvedCorrectnessProfile) {
  return profile.requiredAuthoritativeEvidence.map((evidenceId) => ({
    evidenceId,
    availability: 'authoritative' as const,
  }));
}

describe('[P7-B2 joint preactivation] inactive Diagnostic orchestration', () => {
  it('declares exactly the seven accepted dispatch entries, never keyed by Subject', () => {
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
    expect(source).not.toContain('scenario ===');
  });

  it('routes all eight representative plans to their compiled family path', () => {
    for (const prepared of preparedCases) {
      const entry = resolveFinalEvaluatorDispatch(
        prepared.profile.oracle.evaluatorKind,
        prepared.envelope.plan.route.adapterCompatibilityVersion,
      );
      expect(entry, prepared.fileName).not.toBeNull();
      expect(entry?.evaluatorKind, prepared.fileName).toBe(FAMILY_BY_FILE[prepared.fileName]);
    }
    expect(resolveFinalEvaluatorDispatch('not-an-evaluator', 1)).toBeNull();
    expect(resolveFinalEvaluatorDispatch('geometry-delta', 99)).toBeNull();
  });

  it('executes all eight plans through all seven families with complete UNUSABLE authority', () => {
    const families = new Set<string>();
    for (const prepared of preparedCases) {
      const outcome = executeDiagnosticCase(diagnosticInput(prepared));
      expect(
        outcome.issues,
        `${prepared.fileName}: ${outcome.issues.map((issue) => issue.code).join(', ')}`,
      ).toEqual([]);
      expect(outcome.evaluatorKind).toBe(FAMILY_BY_FILE[prepared.fileName]);
      expect(outcome.launchAttempted).toBe(true);
      expect(outcome.finalOutcome).toBe('HARNESS_BLOCKED');
      expect(outcome.requiredChecks.map((check) => check.checkId)).toEqual(
        prepared.profile.requiredChecks.map((contract) => contract.checkId),
      );
      expect(outcome.requiredChecks.every((check) => check.status === 'UNUSABLE')).toBe(true);
      expect(outcome.record).not.toBeNull();
      if (outcome.record !== null) {
        expect(outcome.record.resolvedProfileFingerprint).toBe(
          prepared.profile.resolvedFingerprint,
        );
        expect(outcome.record.componentFingerprints).toEqual(
          prepared.profile.componentFingerprints,
        );
        expect(readFinalRecord(JSON.parse(JSON.stringify(outcome.record))).kind).toBe('current-v4');
      }
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

  it('classifies a trustworthy ordinary-Text match as PASS and a mismatch as BUG', () => {
    const prepared = preparedCases[0] as PreparedCase;
    const checkId = prepared.profile.requiredChecks[0]?.checkId as string;
    const passDelta = projectOrdinaryTextLiveFact(
      evaluateGeometryDeltaOracle({
        minimumDelta: { x: 40, y: 20 },
        canonicalBefore: { x: 100, y: 100 },
        canonicalAfter: { x: 150, y: 130 },
        renderedBefore: { x: 100, y: 100 },
        renderedAfter: { x: 150, y: 130 },
      }),
    );
    const pass = executeDiagnosticCase(
      diagnosticInput(prepared, {
        observation: observationOf(prepared, {
          evaluatorKind: 'geometry-delta',
          projection: null,
          minimumDelta: { x: 40, y: 20 },
          delta: { ...passDelta, checkId },
          evidence: authoritativeEvidence(prepared.profile),
        }),
      }),
    );
    expect(pass.issues).toEqual([]);
    expect(pass.behaviorOutcome).toBe('PASS');
    expect(pass.finalOutcome).toBe('PASS');

    const bugDelta = projectOrdinaryTextLiveFact(
      evaluateGeometryDeltaOracle({
        minimumDelta: { x: 40, y: 20 },
        canonicalBefore: { x: 100, y: 100 },
        canonicalAfter: { x: 105, y: 105 },
        renderedBefore: { x: 100, y: 100 },
        renderedAfter: { x: 105, y: 105 },
      }),
    );
    const bug = executeDiagnosticCase(
      diagnosticInput(prepared, {
        observation: observationOf(prepared, {
          evaluatorKind: 'geometry-delta',
          projection: null,
          minimumDelta: { x: 40, y: 20 },
          delta: { ...bugDelta, checkId },
          evidence: authoritativeEvidence(prepared.profile),
        }),
      }),
    );
    expect(bug.behaviorOutcome).toBe('BUG');
    expect(bug.finalOutcome).toBe('BUG');
    expect(bug.failingCheckIds.length).toBeGreaterThan(0);
  });

  it('fails closed with no fabricated check or record before allocation authority', () => {
    const prepared = preparedCases[0] as PreparedCase;
    const undelivered: PlanForExecutionResult = { ...prepared.planning, envelope: null };
    const undeliveredOutcome = executeDiagnosticCase(
      diagnosticInput(prepared, { planning: undelivered }),
    );
    expect(undeliveredOutcome.finalOutcome).toBe('HARNESS_BLOCKED');
    expect(undeliveredOutcome.behaviorOutcome).toBeNull();
    expect(undeliveredOutcome.launchAttempted).toBe(false);
    expect(undeliveredOutcome.prelaunch).toBe(true);
    expect(undeliveredOutcome.requiredChecks).toEqual([]);
    expect(undeliveredOutcome.record).toBeNull();
    expect(undeliveredOutcome.issues.map((issue) => issue.code)).toContain('ENVELOPE_UNDELIVERED');

    const allocationFailed = executeDiagnosticCase(
      diagnosticInput(prepared, {
        prelaunch: { kind: 'allocation-failed', reason: 'PORT_UNAVAILABLE', detail: 'busy' },
      }),
    );
    expect(allocationFailed.finalOutcome).toBe('ENVIRONMENT_FAILURE');
    expect(allocationFailed.behaviorOutcome).toBeNull();
    expect(allocationFailed.launchAttempted).toBe(false);
    expect(allocationFailed.record).toBeNull();
    expect(allocationFailed.issues.map((issue) => issue.code)).toContain(
      'EXTERNAL_PREAUTHORITY_FAILURE',
    );
  });

  it('declares a closed, unique issue vocabulary', () => {
    expect(new Set(DIAGNOSTIC_EXECUTION_ISSUE_CODES).size).toBe(
      DIAGNOSTIC_EXECUTION_ISSUE_CODES.length,
    );
    expect(new Set(SUITE_AGGREGATION_ISSUE_CODES).size).toBe(SUITE_AGGREGATION_ISSUE_CODES.length);
    expect(new Set(COMMAND_EXECUTION_ISSUE_CODES).size).toBe(COMMAND_EXECUTION_ISSUE_CODES.length);
    expect(SUITE_AGGREGATION_ISSUE_CODES).toContain('SUITE_CHILD_LEGACY_RECORD');
    expect(COMMAND_EXECUTION_ISSUE_CODES).toContain('COMMAND_AUTHORITY_MIXED');
  });
});

// ── Joint surface: suite child execution and aggregation ─────────────────────

function suiteChildInput(
  prepared: PreparedCase,
  order: number,
  overrides: Partial<SuiteChildExecutionInput> = {},
): SuiteChildExecutionInput {
  return {
    ...diagnosticInput(prepared),
    order,
    caseId: prepared.planning.caseId,
    request: `cases/diagnostic/requests/${prepared.fileName}`,
    expectedOutcome: 'PASS',
    ...overrides,
  };
}

function executeChildren(): SuiteChildOutcome[] {
  return preparedCases.map((prepared, index) =>
    executeSuiteChild(suiteChildInput(prepared, index + 1)),
  );
}

describe('[P7-B2 joint preactivation] suite child execution and aggregation', () => {
  it('executes all eight children, each owning its own distinct envelope', () => {
    const children = executeChildren();
    expect(children).toHaveLength(8);
    const fingerprints = new Set(children.map((child) => child.envelope?.planFingerprint));
    expect(fingerprints.size).toBe(8);
    for (const child of children) {
      expect(child.identityAgrees).toBe(true);
      expect(child.execution.record).not.toBeNull();
    }
  });

  it('aggregates a complete suite preserving every child verdict', () => {
    const result = aggregateSuiteChildren({ declaredCaseCount: 8, children: executeChildren() });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.decision.complete).toBe(true);
    expect(result.decision.children.map((child) => child.order)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(result.decision.children.every((child) => child.recordPresent)).toBe(true);
  });

  it('refuses a legacy, mixed, incomplete, or mis-ordered child record', () => {
    const children = executeChildren();
    const base = children[0] as SuiteChildOutcome;

    const legacyChild: SuiteChildOutcome = {
      ...base,
      execution: {
        ...base.execution,
        record: {
          schemaVersion: 3,
          command: 'diagnostic',
          recordedAt: '2026-01-01T00:00:00.000Z',
          runId: 'legacy-run',
          caseId: base.caseId,
          requiredChecks: [{ checkId: 'geometry.delta', passed: true }],
        } as never,
      },
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
    const mixed = aggregateSuiteChildren({
      declaredCaseCount: 8,
      children: [
        { ...base, execution: { ...base.execution, record: mixedRecord as never } },
        ...children.slice(1),
      ],
    });
    expect(mixed.ok).toBe(false);
    if (!mixed.ok)
      expect(mixed.issues.map((issue) => issue.code)).toContain('SUITE_CHILD_MIXED_RECORD');

    const orderResult = aggregateSuiteChildren({
      declaredCaseCount: 8,
      children: [{ ...base, order: 2 }, ...children.slice(1)],
    });
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
});

// ── Joint surface: Doctor and production-absence command orchestration ───────

const DOCTOR_CHECK_IDS = DOCTOR_COMMAND_CHECKS.map((check) => check.checkId);
const PRODUCTION_CHECK_IDS = PRODUCTION_ABSENCE_COMMAND_CHECKS.map((check) => check.checkId);

function doctorFacts(matches: Readonly<Record<string, boolean>> = {}): CommandCheckFact[] {
  return DOCTOR_COMMAND_CHECKS.map((declaration) => ({
    checkId: declaration.checkId,
    authorityState: 'current' as const,
    matched: matches[declaration.checkId] ?? true,
    actual: { observed: declaration.checkId },
  }));
}

function doctorEvidence(
  availability: CommandEvidenceAvailability = 'authoritative',
): CommandEvidenceFact[] {
  return DOCTOR_COMMAND_REQUIRED_EVIDENCE.map((evidenceId) => ({ evidenceId, availability }));
}

function runDoctor(
  overrides: {
    checks?: readonly CommandCheckFact[];
    evidence?: readonly CommandEvidenceFact[];
    commandAuthority?: CommandStatusAuthority;
  } = {},
): CommandExecutionOutcome {
  return executeDoctorCommandContext({
    commandAuthority: overrides.commandAuthority ?? DOCTOR_COMMAND_STATUS_AUTHORITY,
    checks: overrides.checks ?? doctorFacts(),
    evidence: overrides.evidence ?? doctorEvidence(),
    cleanupSucceeded: true,
  });
}

function observation(attempt: 'initial' | 'reload', clean: boolean): ProductionBrowserObservation {
  return {
    attempt,
    httpStatus: 200,
    finalUrl: `http://127.0.0.1:3210${PRODUCTION_ABSENCE_ROUTE}`,
    title: 'Editor - Artwork',
    observationGlobalType: clean ? 'undefined' : 'object',
    setupGlobalType: 'undefined',
    brokerSlotPresent: false,
    setupAnchorSlotPresent: false,
    documentAnchorSlotPresent: false,
    signalAnchorSlotPresent: !clean,
    requestedPaths: clean
      ? ['/_next/static/chunks/app/page.js']
      : ['/_next/static/chunks/artworkVerificationBridge.js'],
  };
}

function productionFacts(
  options: { artifactClean?: boolean; initialClean?: boolean } = {},
): CommandCheckFact[] {
  const artifactClean = options.artifactClean !== false;
  const hits = artifactClean
    ? scanArtifactContent('dist/server/chunks/app/page.js', 'export const x = 1;')
    : scanArtifactContent(
        'dist/server/chunks/bridge.js',
        `window.${OBSERVATION_GLOBAL_MARKER} = {};`,
      );
  const scan = { clean: hits.length === 0, hits };
  const initial = observation('initial', options.initialClean !== false);
  const reload = observation('reload', true);
  const absence = evaluateProductionAbsence({ scan, observations: [initial, reload] });
  const initialVerdict = evaluateProductionBrowserAbsence(initial);
  const reloadVerdict = evaluateProductionBrowserAbsence(reload);
  return PRODUCTION_ABSENCE_COMMAND_CHECKS.map((declaration) => {
    const matched =
      declaration.checkId === 'production.artifact-absence'
        ? scan.clean
        : declaration.checkId === 'production.browser-absence.initial'
          ? initialVerdict.clean
          : declaration.checkId === 'production.browser-absence.reload'
            ? reloadVerdict.clean
            : true;
    return {
      checkId: declaration.checkId,
      authorityState: 'current' as const,
      matched,
      actual:
        declaration.checkId === 'production.artifact-absence'
          ? { violations: [...absence.violations] }
          : { matched },
    };
  });
}

function runProduction(
  overrides: {
    checks?: readonly CommandCheckFact[];
    evidence?: readonly CommandEvidenceFact[];
    commandAuthority?: CommandStatusAuthority;
  } = {},
): CommandExecutionOutcome {
  return executeProductionAbsenceCommandContext({
    commandAuthority: overrides.commandAuthority ?? PRODUCTION_ABSENCE_COMMAND_STATUS_AUTHORITY,
    checks: overrides.checks ?? productionFacts(),
    evidence:
      overrides.evidence ??
      PRODUCTION_ABSENCE_COMMAND_REQUIRED_EVIDENCE.map((evidenceId) => ({
        evidenceId,
        availability: 'authoritative' as const,
      })),
    cleanupSucceeded: true,
  });
}

describe('[P7-B2 joint preactivation] Doctor and production-absence command orchestration', () => {
  it('classifies both real command contexts PASS and reads strict command-v4 records', () => {
    for (const [outcome, checkIds] of [
      [runDoctor(), DOCTOR_CHECK_IDS],
      [runProduction(), PRODUCTION_CHECK_IDS],
    ] as const) {
      expect(outcome.issues).toEqual([]);
      expect(outcome.behaviorOutcome).toBe('PASS');
      expect(outcome.finalOutcome).toBe('PASS');
      expect(outcome.requiredChecks.map((check) => check.checkId)).toEqual([...checkIds]);
      expect(outcome.requiredChecks.every((check) => check.status === 'PASS')).toBe(true);
      expect(outcome.record).not.toBeNull();
      const read = readFinalRecord(JSON.parse(JSON.stringify(outcome.record)) as unknown);
      expect(read.kind).toBe('command-v4');
    }
  });

  it('fabricates no compiled-profile identity on a command record', () => {
    for (const outcome of [runDoctor(), runProduction()]) {
      const record = outcome.record;
      if (record === null) throw new Error('expected a command record');
      for (const key of [
        'resolvedProfileFingerprint',
        'componentFingerprints',
        'requiredChecks',
        'passed',
        'harnessInvalid',
      ]) {
        expect(Object.hasOwn(record, key), key).toBe(false);
      }
      for (const check of record.checks) {
        for (const key of [
          'actionCycleRef',
          'consumedComponentFingerprints',
          'passed',
          'harnessInvalid',
        ]) {
          expect(Object.hasOwn(check, key), key).toBe(false);
        }
      }
    }
  });

  it('maps real negatives to exact FAIL / BUG and authority negatives to UNUSABLE', () => {
    const doctorBug = runDoctor({
      checks: doctorFacts({ 'doctor.bridge.methods': false }),
    });
    expect(doctorBug.behaviorOutcome).toBe('BUG');
    expect(doctorBug.finalOutcome).toBe('BUG');

    const productionBug = runProduction({ checks: productionFacts({ artifactClean: false }) });
    expect(productionBug.behaviorOutcome).toBe('BUG');

    const unusable = runDoctor({
      checks: doctorFacts().filter((fact) => fact.checkId !== 'doctor.bridge.frozen'),
    });
    expect(
      unusable.requiredChecks.find((check) => check.checkId === 'doctor.bridge.frozen')?.status,
    ).toBe('UNUSABLE');
    expect(unusable.behaviorOutcome).toBe('HARNESS_BLOCKED');
  });

  it('refuses a foreign command authority pre-authority with no fabricated check', () => {
    const outcome = runDoctor({ commandAuthority: PRODUCTION_ABSENCE_COMMAND_STATUS_AUTHORITY });
    expect(outcome.authoritative).toBe(false);
    expect(outcome.preauthority).toBe(true);
    expect(outcome.behaviorOutcome).toBe('HARNESS_BLOCKED');
    expect(outcome.requiredChecks).toEqual([]);
    expect(outcome.record).toBeNull();
    expect(outcome.issues.map((issue) => issue.code)).toContain('COMMAND_AUTHORITY_UNTRUSTWORTHY');
  });

  it('validates each context against its own authority and rejects the foreign set', () => {
    const doctor = runDoctor();
    const production = runProduction();
    expect(validateCommandExecutionChecks(DOCTOR_COMMAND_AUTHORITY, doctor.requiredChecks).ok).toBe(
      true,
    );
    expect(
      validateCommandExecutionChecks(DOCTOR_COMMAND_AUTHORITY, production.requiredChecks).ok,
    ).toBe(false);
    expect(
      DOCTOR_COMMAND_DIAGNOSTIC_EVIDENCE.every(
        (id) => !(DOCTOR_COMMAND_REQUIRED_EVIDENCE as readonly string[]).includes(id),
      ),
    ).toBe(true);
    expect(PRODUCTION_ABSENCE_COMMAND_DIAGNOSTIC_EVIDENCE).toEqual(['production.screenshot']);
    expect(PRODUCTION_ABSENCE_COMMAND_AUTHORITY.command).toBe('production-absence');
  });
});

// ── Joint surface: legacy ambiguity and no legacy translation ────────────────

describe('[P7-B2 joint preactivation] legacy false stays ambiguous and is never translated', () => {
  it('reads v1/v2/v3 boolean records read-only with the historical false preserved', () => {
    for (const [version, label] of [
      [1, 'legacy-v1'],
      [2, 'legacy-v2'],
      [3, 'legacy-v3'],
    ] as const) {
      const legacy = {
        schemaVersion: version,
        command: 'diagnostic',
        recordedAt: '2026-01-01T00:00:00.000Z',
        runId: `legacy-run-${version}`,
        requiredChecks: [{ checkId: 'geometry.delta', passed: false, evidenceIds: ['e1'] }],
      };
      const read = readFinalRecord(legacy);
      expect(read.kind).toBe(`legacy-v${version}`);
      expect(read.legacy).toBe(true);
      expect(read.current).toBe(false);
      expect(read.ambiguous).toBe(true);
      expect(read.label).toBe(label);
      if (!read.legacy) continue;
      expect(read.record).toEqual(legacy);
      expect(read.checks[0]?.passed).toBe(false);
      expect(read.checks[0]?.status).toBeNull();
      expect(read.checks[0]?.ambiguous).toBe(true);
      expect(read.issues.map((issue) => issue.code)).toContain('RESULT_LEGACY_BOOLEAN_AMBIGUOUS');
    }
  });

  it('rejects a mixed boolean/status record rather than translating it', () => {
    const mixed = readFinalRecord({
      schemaVersion: 3,
      requiredChecks: [{ checkId: 'geometry.delta', passed: true, status: 'PASS' }],
    });
    expect(mixed.kind).toBe('mixed');
    expect(mixed.record).toBeNull();
  });

  it('rejects a strict v4 check carrying a legacy boolean or harnessInvalid surface', () => {
    const proof = buildFamilyProofs()[0] as FamilyProof;
    const mutatedBoolean = proof.checks.map((check, index) =>
      index === 0 ? ({ ...check, passed: true } as CorrectnessCheckResult) : check,
    );
    const booleanResult = assembleFinalChildRecordV4(
      assemblyInput(proof, { requiredChecks: mutatedBoolean }),
    );
    expect(booleanResult.ok).toBe(false);
    if (!booleanResult.ok)
      expect(detailIssues(booleanResult)).toContain('RESULT_BOOLEAN_PASSED_PRESENT');

    const mutatedInvalid = proof.checks.map((check, index) =>
      index === 0 ? ({ ...check, harnessInvalid: false } as CorrectnessCheckResult) : check,
    );
    const invalidResult = assembleFinalChildRecordV4(
      assemblyInput(proof, { requiredChecks: mutatedInvalid }),
    );
    expect(invalidResult.ok).toBe(false);
    if (!invalidResult.ok)
      expect(detailIssues(invalidResult)).toContain('RESULT_HARNESS_INVALID_PRESENT');
  });
});

// ── Joint surface: no adapter owns policy ────────────────────────────────────

describe('[P7-B2 joint preactivation] no adapter owns policy', () => {
  const LIVE_FACT_ADAPTERS = [
    'src/adapters/text-live-facts.ts',
    'src/adapters/object-live-facts.ts',
    'src/adapters/image-live-facts.ts',
    'src/adapters/crossword-live-facts.ts',
    'src/adapters/history-live-facts.ts',
    'src/adapters/restore-live-facts.ts',
  ];

  function source(relative: string): string {
    return readFileSync(path.join(skillRoot, relative), 'utf8');
  }

  it('declares no fallback profile id, local required-check list, or authoring-catalogue reload', () => {
    for (const relative of LIVE_FACT_ADAPTERS) {
      const text = source(relative);
      expect(text, relative).not.toContain('loadCatalogueBundle');
      expect(text, relative).not.toContain('loadCorrectnessCatalogue');
      expect(text, relative).not.toContain('compileResolvedCorrectnessProfile');
      expect(text, relative).not.toContain('profile-registry');
      expect(text, relative).not.toContain('readiness/profile-registry');
      expect(text, relative).not.toContain('oracles/profile-registry');
      expect(text, relative).not.toMatch(/fallbackProfileId|defaultProfileId/);
      expect(text, relative).not.toMatch(/subjectId\s*===/);
      expect(text, relative).not.toMatch(/scenario\s*===/);
    }
  });

  it('reads the required-check set only from the exact envelope profile', () => {
    const checkIds = ACCEPTED_B1_PLANS.flatMap((plan) => plan.requiredChecks);
    for (const relative of LIVE_FACT_ADAPTERS) {
      const text = source(relative);
      // No adapter declares a local required-check id literal list; every
      // check id comes from the compiled profile the adapter is handed.
      for (const checkId of checkIds) {
        expect(text, `${relative} hardcodes ${checkId}`).not.toContain(`'${checkId}'`);
      }
      expect(text, relative).not.toMatch(/REQUIRED_CHECKS\s*=\s*\[/);
    }
  });

  it('reads no legacy passed/harnessInvalid authority and no legacy translator', () => {
    for (const relative of LIVE_FACT_ADAPTERS) {
      const text = source(relative);
      expect(text, relative).not.toContain('harnessInvalid as');
      expect(text, relative).not.toMatch(/\.passed\b/);
      expect(text, relative).not.toContain('classifyLegacyCheckResult');
    }
  });
});

// ── Joint surface: envelope disagreement and content completeness ────────────

function leafPaths(value: unknown, prefix: string, out: string[]): void {
  if (Array.isArray(value)) {
    if (value.length === 0) {
      out.push(prefix);
      return;
    }
    value.forEach((entry, index) => {
      leafPaths(entry, `${prefix}[${index}]`, out);
    });
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (key === 'resolvedFingerprint') continue;
      leafPaths(child, prefix === '' ? key : `${prefix}.${key}`, out);
    }
    return;
  }
  out.push(prefix);
}

function setPath(root: Record<string, unknown>, dotted: string, value: unknown): void {
  const tokens = dotted.replace(/\[(\d+)\]/g, '.$1').split('.');
  let cursor: unknown = root;
  for (let index = 0; index < tokens.length - 1; index += 1) {
    const token = tokens[index] as string;
    cursor = (cursor as Record<string, unknown>)[token];
  }
  (cursor as Record<string, unknown>)[tokens[tokens.length - 1] as string] = value;
}

function readLeaf(profile: Record<string, unknown>, dotted: string): unknown {
  const tokens = dotted.replace(/\[(\d+)\]/g, '.$1').split('.');
  let cursor: unknown = profile;
  for (const token of tokens) {
    cursor = (cursor as Record<string, unknown>)[token];
  }
  return cursor;
}

describe('[P7-B2 joint preactivation] envelope agreement and profile content completeness', () => {
  it('fails agreement when any single compiled-profile content leaf is mutated', () => {
    const prepared = preparedCases[0] as PreparedCase;
    const baseProfile = JSON.parse(JSON.stringify(prepared.profile)) as unknown as Record<
      string,
      unknown
    >;
    const paths: string[] = [];
    leafPaths(baseProfile, '', paths);
    expect(paths.length).toBeGreaterThanOrEqual(68);

    let failed = 0;
    for (const leaf of paths) {
      const clone = JSON.parse(JSON.stringify(baseProfile)) as Record<string, unknown>;
      const current = readLeaf(clone, leaf);
      const mutated =
        typeof current === 'boolean'
          ? !current
          : typeof current === 'number'
            ? current + 1
            : typeof current === 'string'
              ? `${current}-mutated`
              : Array.isArray(current)
                ? [1]
                : { mutated: true };
      setPath(clone, leaf, mutated);
      const validation = validateMaterializedExecutionEnvelope({
        envelope: {
          ...prepared.envelope,
          correctnessProfile: clone,
        } as unknown as MaterializedExecutionEnvelopeV1,
        materializedCase: prepared.planning.materializedCase,
      });
      if (!validation.ok) failed += 1;
    }
    // Every semantic profile leaf is fingerprint-covered: a content mutation
    // without a recomputed fingerprint always fails envelope agreement.
    expect(failed).toBe(paths.length);
  });

  it('fails agreement on each representative identity-disagreement class', () => {
    const prepared = preparedCases[0] as PreparedCase;
    const envelope = prepared.envelope;
    const baseProfile = JSON.parse(
      JSON.stringify(envelope.correctnessProfile),
    ) as unknown as Record<string, unknown>;

    const cases: readonly { name: string; mutate: (clone: Record<string, unknown>) => void }[] = [
      {
        name: 'readiness deadline drift',
        mutate: (clone) => {
          (clone.readiness as Record<string, unknown>).deadlineMs =
            ((clone.readiness as Record<string, unknown>).deadlineMs as number) + 1;
        },
      },
      {
        name: 'unsupported evaluator discriminant',
        mutate: (clone) => {
          (clone.oracle as Record<string, unknown>).evaluatorKind = 'ghost-family';
        },
      },
      {
        name: 'invalid component fingerprint',
        mutate: (clone) => {
          (clone.componentFingerprints as Record<string, unknown>).readiness = 'zz';
        },
      },
    ];
    for (const entry of cases) {
      const clone = JSON.parse(JSON.stringify(baseProfile)) as Record<string, unknown>;
      entry.mutate(clone);
      const validation = validateMaterializedExecutionEnvelope({
        envelope: {
          ...envelope,
          correctnessProfile: clone,
        } as unknown as MaterializedExecutionEnvelopeV1,
        materializedCase: prepared.planning.materializedCase,
      });
      expect(validation.ok, entry.name).toBe(false);
      if (validation.ok) continue;
      expect(validation.status, entry.name).toBe('HARNESS_BLOCKED');
      expect(validation.launchAttempted, entry.name).toBe(false);
    }
  });

  it('keeps the accepted 68-field compatibility projection field-exact across all seven routes', () => {
    const baseCatalogue = loadCorrectnessCatalogue();
    expect(auditWp5Compatibility(baseCatalogue)).toEqual([]);

    const EXCLUSIONS: readonly string[] = [
      'route.subjectId',
      'route.capability',
      'route.variant',
      'profileId',
      'readiness.profileId',
      'capture.captureProfileId',
      'oracle.oracleProfileId',
      'capabilityBaseline.capability',
      'subjectAddition.subjectId',
      'subjectAddition.capability',
      'declaredChecks[]',
    ];
    const fields = new Set<string>();
    for (const entry of WP5_COMPATIBILITY_ORACLE) {
      const selection = resolveRouteSelection(baseCatalogue, entry.projection.route);
      if (!selection) throw new Error(`missing route selection for ${entry.projection.profileId}`);
      const compiled = compileResolvedCorrectnessProfile({
        catalogue: baseCatalogue,
        selection,
        declaredChecks: entry.projection.declaredChecks,
      });
      if (!compiled.ok) throw new Error(`unexpected compile failure ${entry.projection.profileId}`);
      const projection = compatibilityProjectionOfCompiledProfile(
        compiled.profile,
        selection,
        entry.projection.declaredChecks,
      );
      const walk = (value: unknown, prefix: string): void => {
        if (Array.isArray(value)) {
          fields.add(`${prefix}[]`);
          if (value.length > 0) walk(value[0], `${prefix}[]`);
          return;
        }
        if (value !== null && typeof value === 'object') {
          for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
            walk(child, prefix === '' ? key : `${prefix}.${key}`);
          }
          return;
        }
        fields.add(prefix);
      };
      walk(projection, '');
    }
    const semantic = [...fields].filter((field) => !EXCLUSIONS.includes(field)).sort();
    expect(semantic).toHaveLength(68);
    expect(new Set(semantic).size).toBe(68);
  });
});

// ── Joint surface: current import boundary, frozen baseline, B2-E inventory ─

describe('[P7-B2 joint preactivation] current import boundary and frozen active baseline', () => {
  const CURRENT_MODULES = [
    'src/adapters/text-live-facts.ts',
    'src/adapters/object-live-facts.ts',
    'src/adapters/image-live-facts.ts',
    'src/adapters/crossword-live-facts.ts',
    'src/adapters/history-live-facts.ts',
    'src/adapters/restore-live-facts.ts',
    'src/contracts/final-record-v4.ts',
    'src/contracts/final-record-reader.ts',
    'src/orchestration/diagnostic-execution.ts',
    'src/orchestration/suite-execution.ts',
    'src/orchestration/command-execution.ts',
    'src/orchestration/doctor-command-execution.ts',
    'src/orchestration/production-absence-command-execution.ts',
  ];

  function source(relative: string): string {
    return readFileSync(path.join(skillRoot, relative), 'utf8');
  }

  function imports(relative: string, module: string): boolean {
    const stem = module.replace(/^src\//, '').replace(/\.ts$/, '');
    const base = path.basename(stem);
    return new RegExp(`from\\s+['"][^'"]*${base}['"]`).test(source(relative));
  }

  it('accounts for every current adapter, contract, and orchestration importer exactly', () => {
    const expected: Readonly<Record<string, readonly string[]>> = {
      'src/adapters/text-live-facts.ts': [
        'src/runtime/execute-plan.ts',
        'src/orchestration/diagnostic-execution.ts',
      ],
      'src/adapters/object-live-facts.ts': [
        'src/runtime/execute-plan.ts',
        'src/orchestration/diagnostic-execution.ts',
      ],
      'src/adapters/image-live-facts.ts': [
        'src/runtime/execute-plan.ts',
        'src/orchestration/diagnostic-execution.ts',
      ],
      'src/adapters/crossword-live-facts.ts': [
        'src/runtime/execute-plan.ts',
        'src/orchestration/diagnostic-execution.ts',
      ],
      'src/adapters/history-live-facts.ts': [
        'src/runtime/execute-plan.ts',
        'src/orchestration/diagnostic-execution.ts',
      ],
      'src/adapters/restore-live-facts.ts': [
        'src/runtime/execute-plan.ts',
        'src/orchestration/diagnostic-execution.ts',
      ],
      'src/contracts/final-record-v4.ts': [
        'src/index.ts',
        'src/contracts/final-record-reader.ts',
        'src/contracts/final-suite-record.ts',
        'src/contracts/final-public-record.ts',
        'src/runtime/execute-plan.ts',
        'src/runtime/execute-restore-plan.ts',
        'src/runtime/execute-crossword-plan.ts',
        'src/runtime/execute-history-plan.ts',
        'src/runtime/execute-image-plan.ts',
        'src/orchestration/final-active-path.ts',
        'src/orchestration/diagnostic-execution.ts',
        'src/orchestration/command-execution.ts',
      ],
      'src/contracts/final-record-reader.ts': [
        'src/index.ts',
        'src/contracts/final-public-record.ts',
        'src/orchestration/suite-execution.ts',
        'src/orchestration/command-execution.ts',
      ],
      'src/orchestration/diagnostic-execution.ts': [
        'src/cli/diagnostic.ts',
        'src/orchestration/suite-execution.ts',
        'src/orchestration/final-active-path.ts',
      ],
      'src/orchestration/suite-execution.ts': ['src/orchestration/final-active-path.ts'],
      'src/orchestration/command-execution.ts': [
        'src/cli/doctor.ts',
        'src/cli/production-absence.ts',
        'src/adapters/doctor-command-live-facts.ts',
        'src/adapters/production-absence-command-live-facts.ts',
        'src/orchestration/production-absence-command-execution.ts',
        'src/orchestration/doctor-command-execution.ts',
        'src/orchestration/final-active-path.ts',
      ],
      'src/orchestration/doctor-command-execution.ts': ['src/orchestration/final-active-path.ts'],
      'src/orchestration/production-absence-command-execution.ts': [
        'src/orchestration/final-active-path.ts',
      ],
    };

    expect(Object.keys(expected).sort()).toEqual([...CURRENT_MODULES].sort());
    for (const [module, expectedImporters] of Object.entries(expected)) {
      const actualImporters = [
        ...new Set(
          [...CURRENT_MODULES, ...expectedImporters, 'src/index.ts']
            .filter((candidate) => candidate !== module)
            .filter((candidate) => imports(candidate, module)),
        ),
      ].sort();
      expect(actualImporters, module).toEqual([...expectedImporters].sort());
    }
  });

  it('keeps the current modules on the final façade and strict-v4 path without legacy writes', () => {
    for (const relative of CURRENT_MODULES) {
      const text = source(relative);
      expect(text, relative).not.toContain('writePublicRunRecord');
      expect(text, relative).not.toContain('writePublicSuiteRecord');
      expect(text, relative).not.toContain("from '../evidence/writer'");
      expect(text, relative).not.toContain("from '../evidence/suite-record'");
      expect(text, relative).not.toContain('contracts/execution');
    }
    expect(source('src/orchestration/diagnostic-execution.ts')).toMatch(
      /import type \{[^}]*FinalExecutionObservation[^}]*\} from '\.\.\/runtime\/execute-plan';/,
    );
    expect(source('src/orchestration/final-active-path.ts')).toContain(
      "from '../evidence/final-writer'",
    );
    for (const relative of [
      'src/cli/diagnostic.ts',
      'src/cli/suite.ts',
      'src/cli/doctor.ts',
      'src/cli/production-absence.ts',
    ]) {
      expect(source(relative), relative).toContain('orchestration/final-active-path');
    }
  });

  it('retains the boolean/v3 contracts only as historical or compatibility surfaces', () => {
    expect(source('src/contracts/execution.ts')).toMatch(
      /export interface CheckResult \{\n {2}checkId: string;\n {2}passed: boolean;\n\}/,
    );
    expect(source('src/contracts/schema-versions.ts')).toContain(
      'export const DIAGNOSTIC_RUN_RECORD_SCHEMA_VERSION = 3;',
    );
    expect(source('src/runtime/outcomes.ts')).toContain('harnessInvalid');
    const barrel = source('src/index.ts');
    for (const marker of [
      'final-record-v4',
      'final-record-reader',
      'final-public-record',
      'final-suite-record',
    ]) {
      expect(barrel, marker).toContain(marker);
    }
    for (const marker of [
      'planCaseForExecution',
      'MaterializedExecutionEnvelope',
      'orchestration/',
      'live-facts',
    ]) {
      expect(barrel, marker).not.toContain(marker);
    }
  });
});

describe('[P7-B2 joint preactivation] eventual B2-E activation target inventory', () => {
  function source(relative: string): string {
    return readFileSync(path.join(skillRoot, relative), 'utf8');
  }

  /** The ten ADR 0029 §4 B2-E targets, all asserted in their activated state. */
  const B2E_TARGETS: readonly { id: string; target: string; activated: () => boolean }[] = [
    {
      id: 'B2E-1',
      target: 'Diagnostic and suite planning switch to planCaseForExecution',
      activated: () =>
        source('src/cli/diagnostic.ts').includes('orchestration/final-active-path') &&
        source('src/cli/suite.ts').includes('orchestration/final-active-path'),
    },
    {
      id: 'B2E-2',
      target: 'each exact envelope passed through allocation and execution',
      activated: () =>
        source('src/runtime/execute-plan.ts').includes('MaterializedExecutionEnvelope') &&
        source('src/orchestration/diagnostic-execution.ts').includes(
          'MaterializedExecutionEnvelope',
        ),
    },
    {
      id: 'B2E-3',
      target: 'install all seven fact-adapter/kernel paths',
      activated: () =>
        ['text', 'object', 'image', 'crossword', 'history', 'restore'].every((family) =>
          source('src/orchestration/diagnostic-execution.ts').includes(`${family}-live-facts`),
        ),
    },
    {
      id: 'B2E-4',
      target: 'switch to status-derived classification',
      activated: () =>
        source('src/orchestration/diagnostic-execution.ts').includes('classifyStatusOutcome') &&
        source('src/orchestration/command-execution.ts').includes('evaluateCommandContext'),
    },
    {
      id: 'B2E-5',
      target: 'remove active harnessInvalid classification authority',
      activated: () =>
        !source('src/orchestration/diagnostic-execution.ts').includes('harnessInvalid') &&
        !source('src/orchestration/command-execution.ts').includes('harnessInvalid'),
    },
    {
      id: 'B2E-6',
      target: 'activate strict v4 writer and nested projections',
      activated: () =>
        source('src/orchestration/final-active-path.ts').includes('final-writer') &&
        source('src/contracts/final-record-v4.ts').includes('FinalNestedProjectionV4'),
    },
    {
      id: 'B2E-7',
      target: 'activate strict current/legacy reader discrimination',
      activated: () =>
        source('src/contracts/final-record-reader.ts').includes('readFinalRecord') &&
        source('src/evidence/final-reader.ts').includes('readFinalPublicRecordFile'),
    },
    {
      id: 'B2E-8',
      target: 'activate Doctor and production-absence status command adapters',
      activated: () =>
        source('src/cli/doctor.ts').includes('doctor-command-live-facts') &&
        source('src/cli/production-absence.ts').includes('production-absence-command-live-facts'),
    },
    {
      id: 'B2E-9',
      target: 'remove current public boolean check exports and compatibility writers',
      activated: () =>
        source('src/index.ts').includes('final-record-v4') &&
        !source('src/index.ts').includes('writePublicRunRecordV3'),
    },
    {
      id: 'B2E-10',
      target: 'migrate current-contract tests to v4/status expectations',
      activated: () =>
        source('src/contracts/schema-versions.ts').includes(
          'DIAGNOSTIC_RUN_RECORD_SCHEMA_VERSION = 3;',
        ) &&
        source('src/contracts/final-record-v4.ts').includes(
          'FINAL_CURRENT_CHILD_RECORD_SCHEMA_VERSION',
        ),
    },
  ];

  it('inventories exactly ten B2-E targets, each activated by the post-cutover path', () => {
    expect(B2E_TARGETS).toHaveLength(10);
    expect(new Set(B2E_TARGETS.map((entry) => entry.id)).size).toBe(10);
    for (const entry of B2E_TARGETS) {
      expect(entry.activated(), `${entry.id}: ${entry.target}`).toBe(true);
    }
  });
});
