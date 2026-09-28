import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import {
  DOCTOR_COMMAND_AUTHORITY,
  DOCTOR_COMMAND_CHECKS,
  DOCTOR_COMMAND_REQUIRED_EVIDENCE,
  DOCTOR_COMMAND_STATUS_AUTHORITY,
  OBSERVATION_GLOBAL_MARKER,
  PRODUCTION_ABSENCE_COMMAND_AUTHORITY,
  PRODUCTION_ABSENCE_COMMAND_CHECKS,
  PRODUCTION_ABSENCE_COMMAND_REQUIRED_EVIDENCE,
  PRODUCTION_ABSENCE_COMMAND_STATUS_AUTHORITY,
  PRODUCTION_ABSENCE_ROUTE,
  evaluateGeometryDeltaOracle,
  evaluateProductionAbsence,
  evaluateProductionBrowserAbsence,
  scanArtifactContent,
} from '../../src/index';
import type {
  CommandCheckFact,
  CommandEvidenceFact,
  CommandStatusAuthority,
  ProductionBrowserObservation,
} from '../../src/index';
import type { DiagnosticExecutionInput } from '../../src/orchestration/diagnostic-execution';
import type { FinalExecutionPayload } from '../../src/runtime/execute-plan';
import { projectOrdinaryTextLiveFact } from '../../src/adapters/text-live-facts';
import { deriveWorkflowStepCatalogueFingerprint } from '../../src/catalogue/fingerprint';
import { loadCatalogueBundle, type CatalogueBundle } from '../../src/catalogue/load';
import { loadDiagnosticSuite, resolveSuiteRequests } from '../../src/catalogue/suite';
import type {
  ActionCycleCorrectnessIdentity,
  ResolvedCorrectnessProfile,
} from '../../src/contracts/correctness';
import type { Capability } from '../../src/contracts/discriminants';
import { readFinalPublicRecordFile } from '../../src/evidence/final-reader';
import {
  buildCleanupProjection,
  buildEstablishedOwnership,
  buildPublicLaunchFacts,
  PUBLIC_PATH_REF_DOMAIN,
  PUBLIC_PATH_ROLES,
} from '../../src/evidence/public-dto';
import { RunRecordExistsError } from '../../src/evidence/writer';
import {
  FINAL_ACTIVE_PATH_CLI_SCHEMA_VERSION,
  FINAL_ACTIVE_PATH_EXIT_CODES,
  finalExitCodeForOutcome,
  finalStatusForOutcome,
  planFinalActivePathCase,
  projectFinalCliResult,
  runFinalDiagnosticActivePath,
  runFinalDoctorActivePath,
  runFinalProductionAbsenceActivePath,
  runFinalSuiteActivePath,
  type FinalActivePathCommandOperationals,
  type FinalActivePathRunOperationals,
  type FinalDiagnosticActivePathInput,
  type FinalSuiteActivePathInput,
  type FinalSuiteAggregateContext,
  type FinalSuiteMemberInput,
} from '../../src/orchestration/final-active-path';
import {
  FINAL_SWITCH_FACADE_MARKERS,
  FINAL_SWITCH_HISTORICAL_FIXTURES,
  FINAL_SWITCH_MANIFEST,
  finalSwitchManifestIssues,
  type FinalSwitchManifestView,
} from '../../src/orchestration/final-switch-manifest';
import type { MaterializedExecutionEnvelopeV1 } from '../../src/planner/execution-materialization';
import { planCaseForExecution, type PlanForExecutionResult } from '../../src/planner/plan-case';
import {
  CHECK_RESULT_CONTRACT_SCHEMA_VERSION,
  CLI_RESULT_SCHEMA_VERSION,
} from '../../src/contracts/schema-versions';
import { EXIT_CODES, parseCliResultEnvelope, statusForOutcome } from '../../src/cli/output';
import { DEFAULT_ENVIRONMENT_CELL_ID } from '../../src/runtime/environment';
import { resolveToolkitRoot } from '../../src/runtime/paths';
import type { CleanupResult, RunOwnershipRecord } from '../../src/contracts/runtime';

/**
 * P7-B2-E2 focused proof: inactive full active-path façade and frozen B2-E3
 * switch manifest (ADR 0030 §B2-E2, ADR 0029 §4 B2-D/B2-E, ADR 0025 §4/§7).
 *
 * The suites drive the *real* exact envelopes produced by `planCaseForExecution`
 * through the current façade, covering standalone Diagnostic planning and
 * execution, suite preflight/children/aggregation, allocation/no-launch and
 * rejection paths, Doctor and production-absence, durable strict-v4 record
 * production, CLI status/details projection, and cleanup/finalization
 * precedence. They independently freeze the B2-E3 switch manifest against a
 * repository view and prove its post-cutover closure is complete.
 *
 * Every durable write targets an isolated temporary directory. No accepted run
 * or suite evidence is written and no active evidence location is reachable.
 */

const skillRoot = resolveToolkitRoot();
const repoRoot = path.resolve(skillRoot, '..', '..', '..');
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

/** Accepted B1/B2 representative plan identities; the façade must not move any. */
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

const FAMILY_BY_EVALUATOR: Readonly<Record<string, string>> = Object.freeze({
  'geometry-delta': 'text-ordinary',
  'warped-text-envelope': 'text-warped',
  'nested-object-affine': 'nested-object',
  'image-upload-replace': 'image',
  'crossword-determinism': 'crossword',
  'history-cross-subject': 'history',
  'frontend-restore': 'restore',
});

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

function representativeRequest(fileName: string): unknown {
  const entry = resolvedRequests.find(
    (candidate) => path.basename(candidate.relativePath) === fileName,
  );
  if (entry === undefined) throw new Error(`missing representative request ${fileName}`);
  return entry.request;
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
      actionCycleId: `b2e2-cycle-${fileName}`,
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

/** The delivered no-authority payload for the compiled family (UNUSABLE checks). */
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
        targetId: 'b2e2-image-target',
        expectedLayoutId: 'b2e2-image-layout',
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
            hostLayoutId: 'b2e2-crossword-host',
            createdTargetId: 'b2e2-crossword-target',
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
          retainedLayoutId: 'b2e2-history-layout',
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
          sourceDocumentId: 'b2e2-restore-source',
          restoredDocumentId: 'b2e2-restore-restored',
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

function authoritativeEvidence(profile: ResolvedCorrectnessProfile) {
  return profile.requiredAuthoritativeEvidence.map((evidenceId) => ({
    evidenceId,
    availability: 'authoritative' as const,
  }));
}

/** A trustworthy ordinary-Text PASS payload for the first representative case. */
function passTextPayload(prepared: PreparedCase): FinalExecutionPayload {
  const checkId = prepared.profile.requiredChecks[0]?.checkId as string;
  const delta = projectOrdinaryTextLiveFact(
    evaluateGeometryDeltaOracle({
      minimumDelta: { x: 40, y: 20 },
      canonicalBefore: { x: 100, y: 100 },
      canonicalAfter: { x: 150, y: 130 },
      renderedBefore: { x: 100, y: 100 },
      renderedAfter: { x: 150, y: 130 },
    }),
  );
  return {
    evaluatorKind: 'geometry-delta',
    projection: null,
    minimumDelta: { x: 40, y: 20 },
    delta: { ...delta, checkId },
    evidence: authoritativeEvidence(prepared.profile),
  };
}

/** A product-mismatch ordinary-Text BUG payload. */
function bugTextPayload(prepared: PreparedCase): FinalExecutionPayload {
  const checkId = prepared.profile.requiredChecks[0]?.checkId as string;
  const delta = projectOrdinaryTextLiveFact(
    evaluateGeometryDeltaOracle({
      minimumDelta: { x: 40, y: 20 },
      canonicalBefore: { x: 100, y: 100 },
      canonicalAfter: { x: 105, y: 105 },
      renderedBefore: { x: 100, y: 100 },
      renderedAfter: { x: 105, y: 105 },
    }),
  );
  return {
    evaluatorKind: 'geometry-delta',
    projection: null,
    minimumDelta: { x: 40, y: 20 },
    delta: { ...delta, checkId },
    evidence: authoritativeEvidence(prepared.profile),
  };
}

// ── Safe operational fixtures ────────────────────────────────────────────────

const OWNERSHIP_FIXTURE: RunOwnershipRecord = {
  runId: 'b2e2-owned-run',
  repoRoot: '/b2e2-fixture-repo',
  skillRoot: '/b2e2-fixture-repo/.pi/skills/verify-artwork-editor',
  repoRelativeDistDir: '.next/verify-runs/b2e2-owned-run',
  distDir: '/b2e2-fixture-repo/.next/verify-runs/b2e2-owned-run',
  scratchRoot: '/b2e2-fixture-scratch/b2e2-owned-run',
  evidenceRoot: '/b2e2-fixture-evidence/b2e2-owned-run',
  routeNamespace: 'b2e2-route-namespace',
  storageNamespace: 'b2e2-storage-namespace',
  port: 4321,
  baseUrl: 'http://127.0.0.1:4321',
  environmentCellId: DEFAULT_ENVIRONMENT_CELL_ID,
  schemaVersion: 1,
  owner: 'verify-artwork-editor',
  state: 'launched',
  createdAt: '2026-09-20T00:00:00.000Z',
  updatedAt: '2026-09-20T00:00:00.000Z',
  processPid: 4242,
  processGroupId: 4242,
  ownedCommand: null,
  serverLogPath: '/b2e2-fixture-scratch/b2e2-owned-run/server.log',
  repoConfigSnapshot: null,
  activeCase: null,
};

const CLEANUP_FIXTURE: CleanupResult = {
  schemaVersion: 1,
  runId: 'b2e2-owned-run',
  attempted: true,
  complete: true,
  alreadyClean: false,
  refusedReason: null,
  detail: 'fixture cleanup',
  verification: {
    processSignalled: 15,
    processEscalated: false,
    processDead: true,
    portClosed: true,
    distDirRemoved: true,
    scratchRemoved: true,
    configRestored: true,
    browserClosed: true,
    evidencePreserved: true,
  },
  diagnostics: [],
};

/** The operational region of the public v4 child record, tied to one run id. */
function operationalFor(
  prepared: PreparedCase,
  runId: string,
  overrides: Partial<FinalActivePathRunOperationals> = {},
): FinalActivePathRunOperationals {
  const contracts = prepared.planning.materializedCase.contracts;
  const route = prepared.planning.materializedCase.route;
  const fixture = prepared.planning.materializedCase.fixture;
  const profile = prepared.profile;
  return {
    provenance: prepared.planning.request.provenance,
    evidenceDepth: prepared.planning.request.evidenceDepth,
    environmentCellId: DEFAULT_ENVIRONMENT_CELL_ID,
    repository: {
      commit: contracts.registryFingerprint.slice(0, 40),
      dirty: true,
      lockfileDigest: contracts.applicationInventoryFingerprint,
    },
    fingerprints: {
      registry: contracts.registryFingerprint,
      applicationInventory: contracts.applicationInventoryFingerprint,
      operationCatalogue: contracts.operationCatalogueFingerprint,
      adapterCatalogue: contracts.adapterCatalogueFingerprint,
      workflowCatalogue: contracts.workflowCatalogueFingerprint,
      workflowSteps: deriveWorkflowStepCatalogueFingerprint(bundle.workflowStepCatalogue),
      coverageModel: contracts.coverageModelFingerprint,
      readinessProfile: `${profile.readiness.profileId}@${profile.readiness.schemaVersion}`,
      oracleProfile: `${profile.oracle.oracleProfileId}@${profile.oracle.schemaVersion}`,
    },
    adapter: {
      adapterId: route.adapterId,
      compatibilityVersion: route.adapterCompatibilityVersion,
    },
    workflow: { workflowId: route.workflowId, version: contracts.workflowVersion },
    fixture:
      fixture === undefined
        ? { fixtureId: 'b2e2-no-fixture', constructorId: 'b2e2-none', constructorVersion: 1 }
        : {
            fixtureId: fixture.fixtureId,
            constructorId: fixture.constructorId,
            constructorVersion: fixture.constructorVersion,
          },
    targets: [{ role: 'b2e2-target-role', elementId: 'b2e2-target-element' }],
    readiness: {
      profileId: profile.readiness.profileId,
      timingCategory: profile.readiness.deadlineCategory,
      deadlineMs: profile.readiness.deadlineMs,
      wakeSource: 'none',
      fallbackPollCount: 0,
      watchdogWaits: 0,
      rendererStableFrames: 0,
      timings: { setup: 12, action: 34 },
    },
    launch: buildPublicLaunchFacts({
      attempted: true,
      pid: 4242,
      processGroupId: 4242,
      readinessMs: 812,
      serverLogPath: '/b2e2-fixture-scratch/b2e2-owned-run/server.log',
    }),
    ownership: buildEstablishedOwnership(
      { ...OWNERSHIP_FIXTURE, runId },
      'launched',
      `.next/verify-runs/${runId}`,
      '.pi/skills/verify-artwork-editor',
    ),
    cleanup: buildCleanupProjection({ ...CLEANUP_FIXTURE, runId }),
    diagnostics: [],
    runError: null,
    recordedAt: '2026-09-20T00:00:00.000Z',
    ...overrides,
  };
}

const preparedCases: readonly PreparedCase[] = REPRESENTATIVE_FILES.map((fileName) =>
  prepare(fileName),
);

// ── Isolated temporary evidence roots ────────────────────────────────────────

const createdRoots: string[] = [];

function tempEvidenceRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'p7b-b2e2-'));
  createdRoots.push(root);
  return root;
}

afterAll(() => {
  for (const root of createdRoots) rmSync(root, { recursive: true, force: true });
});

function diagnosticInput(
  prepared: PreparedCase,
  runId: string,
  overrides: Partial<FinalDiagnosticActivePathInput> = {},
): FinalDiagnosticActivePathInput {
  return {
    planning: prepared.planning,
    prelaunch: {
      kind: 'reserved',
      allocationId: `b2e2-allocation-${prepared.fileName}`,
      executionInstanceId: `b2e2-instance-${prepared.fileName}`,
    },
    observation: observationOf(prepared, noAuthorityPayload(prepared)),
    runId,
    cleanupSucceeded: true,
    operational: operationalFor(prepared, runId),
    durable: { evidenceRoot: tempEvidenceRoot() },
    ...overrides,
  };
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
    observationId: 'b2e2-observation',
  };
}

function runDiagnostic(
  prepared: PreparedCase,
  overrides: Partial<FinalDiagnosticActivePathInput> = {},
) {
  const runId = `b2e2-run-${prepared.fileName}`;
  return runFinalDiagnosticActivePath(diagnosticInput(prepared, runId, overrides));
}

// ── CLI projection parity with the real active CLI contract ──────────────────

describe('[P7-B2-E2] CLI status/details projection matches the active CLI contract', () => {
  it('mirrors the active CLI schema version and outcome/exit mapping exactly', () => {
    expect(FINAL_ACTIVE_PATH_CLI_SCHEMA_VERSION).toBe(CLI_RESULT_SCHEMA_VERSION);
    expect(FINAL_ACTIVE_PATH_EXIT_CODES).toEqual(EXIT_CODES);
    for (const outcome of ['PASS', 'BUG', 'HARNESS_BLOCKED', 'ENVIRONMENT_FAILURE'] as const) {
      expect(finalStatusForOutcome(outcome)).toBe(statusForOutcome(outcome));
      expect(finalExitCodeForOutcome(outcome)).toBe(EXIT_CODES[statusForOutcome(outcome)]);
    }
  });

  it('emits an envelope the active parser accepts and refuses a contradiction', () => {
    const envelope = projectFinalCliResult<null>({
      command: 'diagnostic',
      status: 'BUG',
      outcome: 'BUG',
      detail: 'x',
      launchAttempted: true,
      details: null,
    });
    const parsed = parseCliResultEnvelope(envelope);
    expect(parsed.status).toBe('BUG');
    expect(parsed.exitCode).toBe(1);
    expect(parsed.launchAttempted).toBe(true);
    expect(() =>
      projectFinalCliResult<null>({
        command: 'diagnostic',
        status: 'ENVIRONMENT_FAILURE',
        outcome: 'BUG',
        detail: 'x',
      }),
    ).toThrow(/Contradictory/);
  });
});

// ── Standalone Diagnostic façade across all eight plans / seven families ─────

describe('[P7-B2-E2] standalone Diagnostic façade across all eight plans and seven families', () => {
  it('exposes exactly the eight accepted requests at their accepted identities', () => {
    expect(preparedCases.map((prepared) => prepared.fileName)).toEqual([...REPRESENTATIVE_FILES]);
    for (const prepared of preparedCases) {
      expect(prepared.envelope.caseId).toBe(prepared.baseline.caseId);
      expect(prepared.envelope.materializationFingerprint).toBe(
        prepared.baseline.materializationFingerprint,
      );
      expect(prepared.envelope.planFingerprint).toBe(prepared.baseline.planFingerprint);
      expect(prepared.profile.profileId).toBe(prepared.baseline.profileId);
      expect(prepared.profile.resolvedFingerprint).toBe(
        prepared.baseline.correctnessProfileFingerprint,
      );
      expect(prepared.profile.requiredChecks.map((check) => check.checkId)).toEqual([
        ...prepared.baseline.requiredChecks,
      ]);
    }
  });

  it('plans through the façade without recompiling the public plan', () => {
    for (const prepared of preparedCases) {
      const planned = planFinalActivePathCase(representativeRequest(prepared.fileName), bundle);
      expect(planned.status).toBe('PLANNED');
      if (planned.status !== 'PLANNED') continue;
      expect(planned.planFingerprint).toBe(prepared.baseline.planFingerprint);
      expect(planned.materializationFingerprint).toBe(prepared.baseline.materializationFingerprint);
      expect(planned.envelope).not.toBeNull();
    }
  });

  it('drives all eight plans through the façade and durably records each as current v4', {
    timeout: 15_000,
  }, () => {
    const seenFamilies = new Set<string>();
    for (const prepared of preparedCases) {
      const outcome = runDiagnostic(prepared);
      seenFamilies.add(FAMILY_BY_EVALUATOR[prepared.profile.oracle.evaluatorKind] as string);

      expect(outcome.execution.caseId).toBe(prepared.baseline.caseId);
      expect(outcome.execution.materializationFingerprint).toBe(
        prepared.baseline.materializationFingerprint,
      );
      expect(outcome.execution.planFingerprint).toBe(prepared.baseline.planFingerprint);
      expect(outcome.execution.launchAttempted).toBe(true);
      expect(outcome.execution.requiredChecks.map((check) => check.checkId).sort()).toEqual(
        [...prepared.baseline.requiredChecks].sort(),
      );

      // The façade required a durable record and it reached disk and read back.
      expect(outcome.durable.required).toBe(true);
      expect(outcome.durable.wrote).toBe(true);
      expect(outcome.durable.path).not.toBeNull();
      const read = readFinalPublicRecordFile(outcome.durable.path as string);
      expect(read.kind).toBe('current-v4');
      expect(read.current).toBe(true);
      if (read.record === null || !('resolvedProfileFingerprint' in read.record)) continue;
      expect(read.record.resolvedProfileFingerprint).toBe(
        prepared.baseline.correctnessProfileFingerprint,
      );
      expect(
        (
          read.record as unknown as { requiredChecks: readonly { checkId: string }[] }
        ).requiredChecks.map((check) => check.checkId),
      ).toEqual([...prepared.baseline.requiredChecks]);
      // The byte-exact guarded bytes were written.
      const onDisk = readFileSync(outcome.durable.path as string, 'utf8');
      expect(onDisk).toBe(outcome.durable.serialized as string);
    }
    expect([...seenFamilies].sort()).toEqual(
      [
        'crossword',
        'history',
        'image',
        'nested-object',
        'restore',
        'text-ordinary',
        'text-warped',
      ].sort(),
    );
  });

  it('classifies a trustworthy ordinary-Text match as PASS and a mismatch as BUG', () => {
    const prepared = preparedCases[0] as PreparedCase;
    const pass = runDiagnostic(prepared, {
      observation: observationOf(prepared, passTextPayload(prepared)),
    });
    expect(pass.execution.issues).toEqual([]);
    expect(pass.execution.behaviorOutcome).toBe('PASS');
    expect(pass.finalOutcome).toBe('PASS');
    expect(pass.cli.status).toBe('PASS');
    expect(pass.cli.exitCode).toBe(0);
    expect(pass.cli.details?.requiredChecks).toEqual([
      { checkId: 'geometry.delta', status: 'PASS' },
    ]);

    const bug = runDiagnostic(prepared, {
      observation: observationOf(prepared, bugTextPayload(prepared)),
    });
    expect(bug.execution.behaviorOutcome).toBe('BUG');
    expect(bug.finalOutcome).toBe('BUG');
    expect(bug.cli.status).toBe('BUG');
    expect(bug.cli.exitCode).toBe(1);
    expect(bug.cli.details?.requiredChecks).toEqual([
      { checkId: 'geometry.delta', status: 'FAIL' },
    ]);
  });

  it('converts an incomplete cleanup into ENVIRONMENT_FAILURE while preserving behavior', () => {
    const prepared = preparedCases[0] as PreparedCase;
    const outcome = runDiagnostic(prepared, {
      observation: observationOf(prepared, passTextPayload(prepared)),
      cleanupSucceeded: false,
    });
    expect(outcome.execution.behaviorOutcome).toBe('PASS');
    expect(outcome.finalOutcome).toBe('ENVIRONMENT_FAILURE');
    expect(outcome.cli.status).toBe('ENVIRONMENT_FAILURE');
    expect(outcome.cli.details?.behaviorOutcome).toBe('PASS');
  });

  it('keeps launchAttempted false and produces no record on an external pre-authority failure', () => {
    for (const prepared of preparedCases) {
      const outcome = runDiagnostic(prepared, {
        prelaunch: { kind: 'allocation-failed', reason: 'PORT_UNAVAILABLE', detail: 'occupied' },
      });
      expect(outcome.execution.launchAttempted).toBe(false);
      expect(outcome.execution.prelaunch).toBe(true);
      expect(outcome.execution.behaviorOutcome).toBeNull();
      expect(outcome.execution.requiredChecks).toEqual([]);
      expect(outcome.execution.record).toBeNull();
      expect(outcome.durable.required).toBe(false);
      expect(outcome.durable.attempted).toBe(false);
      expect(outcome.finalOutcome).toBe('ENVIRONMENT_FAILURE');
      expect(outcome.cli.status).toBe('ENVIRONMENT_FAILURE');
    }
  });

  it('fails closed with the trustworthy planned identities when the envelope is undelivered', () => {
    const prepared = preparedCases[0] as PreparedCase;
    const outcome = runDiagnostic(prepared, {
      planning: { ...prepared.planning, envelope: null },
    });
    expect(outcome.execution.finalOutcome).toBe('HARNESS_BLOCKED');
    expect(outcome.execution.launchAttempted).toBe(false);
    expect(outcome.execution.record).toBeNull();
    expect(outcome.execution.caseId).toBe(prepared.baseline.caseId);
    expect(outcome.cli.launchAttempted).toBe(false);
    expect(outcome.cli.details?.issues).toContain('ENVELOPE_UNDELIVERED');
  });
});

// ── Durable strict-v4 production order and finalization precedence ───────────

describe('[P7-B2-E2] durable strict-v4 production order and finalization precedence', () => {
  it('writes assembly → redaction → exclusive write → readback in that order', () => {
    const prepared = preparedCases[0] as PreparedCase;
    const root = tempEvidenceRoot();
    const ok = runDiagnostic(prepared, {
      observation: observationOf(prepared, passTextPayload(prepared)),
      durable: { evidenceRoot: root },
    });
    expect(ok.durable.wrote).toBe(true);
    expect(existsSync(path.join(root, 'run-record.json'))).toBe(true);
    expect(readFileSync(path.join(root, 'run-record.json'), 'utf8')).toBe(
      ok.durable.serialized as string,
    );

    // Redaction happens before any byte reaches disk: an unsafe public value
    // refuses the write with no file created.
    const unsafeRoot = tempEvidenceRoot();
    const unsafe = runDiagnostic(prepared, {
      observation: observationOf(prepared, passTextPayload(prepared)),
      operational: operationalFor(prepared, `b2e2-run-${prepared.fileName}`, {
        diagnostics: [
          {
            code: 'EVIDENCE_REDACTION_REJECTED',
            severity: 'warning',
            detail: 'transient handle file:///tmp/leaked',
            subjectId: null,
            applicationKind: null,
            context: { issueCode: 'B2E2_UNSAFE' },
          },
        ],
      }),
      durable: { evidenceRoot: unsafeRoot },
    });
    expect(unsafe.durable.attempted).toBe(true);
    expect(unsafe.durable.wrote).toBe(false);
    expect(unsafe.durable.error).toMatch(/Redaction rejected|REDACTION_PROHIBITED_VALUE/);
    expect(existsSync(path.join(unsafeRoot, 'run-record.json'))).toBe(false);
    expect(unsafe.finalOutcome).toBe('HARNESS_BLOCKED');
    expect(unsafe.cli.status).not.toBe('PASS');

    // Exclusive creation: a duplicate target fails and never overwrites.
    const duplicateRoot = tempEvidenceRoot();
    const target = path.join(duplicateRoot, 'run-record.json');
    const existing = JSON.stringify({ schemaVersion: 3, command: 'diagnostic' });
    writeFileSync(target, `${existing}\n`, 'utf8');
    const duplicate = runDiagnostic(prepared, {
      observation: observationOf(prepared, passTextPayload(prepared)),
      durable: { evidenceRoot: duplicateRoot },
    });
    expect(duplicate.durable.wrote).toBe(false);
    expect(duplicate.durable.failureClass).toBe('HARNESS_BLOCKED');
    expect(duplicate.durable.error).toMatch(/did not commit the final manifest/i);
    expect(readFileSync(target, 'utf8')).toBe(`${existing}\n`);
  });

  it('prevents a final PASS when the required durable record cannot be finalized', () => {
    const prepared = preparedCases[0] as PreparedCase;
    const outcome = runDiagnostic(prepared, {
      observation: observationOf(prepared, passTextPayload(prepared)),
      writeRecord: () => {
        throw new RunRecordExistsError('injected finalization failure');
      },
    });
    expect(outcome.execution.finalOutcome).toBe('PASS');
    expect(outcome.durable.attempted).toBe(true);
    expect(outcome.durable.wrote).toBe(false);
    expect(outcome.finalOutcome).toBe('HARNESS_BLOCKED');
    expect(outcome.cli.status).not.toBe('PASS');
    expect(outcome.cli.details?.behaviorOutcome).toBe('PASS');
  });

  it('owns no default or active evidence location and writes only to the explicit sink', () => {
    const runsRoot = path.join(skillRoot, 'evidence', 'runs');
    const before = existsSync(runsRoot) ? readdirSync(runsRoot).sort() : [];
    const prepared = preparedCases[0] as PreparedCase;
    runDiagnostic(prepared, { observation: observationOf(prepared, passTextPayload(prepared)) });
    const after = existsSync(runsRoot) ? readdirSync(runsRoot).sort() : [];
    expect(after).toEqual(before);
  });
});

// ── Suite preflight, children, aggregation ───────────────────────────────────

function suiteMember(prepared: PreparedCase, order: number): FinalSuiteMemberInput {
  const runId = `b2e2-suite-${order}-${prepared.fileName}`;
  return {
    ...diagnosticInput(prepared, runId),
    order,
    caseId: prepared.baseline.caseId,
    requestPath: prepared.fileName,
    expectedOutcome: 'PASS',
  };
}

/** The safe aggregate operational context for the inactive v4-bound suite path. */
const SUITE_AGGREGATE_CONTEXT: FinalSuiteAggregateContext = {
  suiteExecutionId: 'b2e2-suite-execution',
  suiteLineageId: 'b2e2-suite-lineage',
  suiteFingerprint: 'a'.repeat(64),
  repository: {
    commit: 'b2e2-suite-commit',
    dirty: true,
    lockfileDigest: 'b2e2-suite-lockfile',
  },
  startedAt: '2026-09-20T00:00:00.000Z',
  endedAt: '2026-09-20T00:01:00.000Z',
  durationMs: 60_000,
  recordedAt: '2026-09-20T00:01:00.000Z',
};

function suiteRunInput(
  overrides: Partial<FinalSuiteActivePathInput> &
    Pick<FinalSuiteActivePathInput, 'suiteId' | 'suiteVersion' | 'declaredCaseCount' | 'members'>,
): FinalSuiteActivePathInput {
  return {
    aggregate: SUITE_AGGREGATE_CONTEXT,
    suiteDurable: { evidenceRoot: tempEvidenceRoot() },
    ...overrides,
  };
}

describe('[P7-B2-E2] suite preflight, child identity, and aggregation', () => {
  it('runs the eight representative children, each with its own envelope and record', {
    timeout: 15_000,
  }, () => {
    const members = preparedCases.map((prepared, index) => suiteMember(prepared, index + 1));
    const outcome = runFinalSuiteActivePath(
      suiteRunInput({
        suiteId: 'representative',
        suiteVersion: 1,
        declaredCaseCount: 8,
        members,
      }),
    );
    expect(outcome.preflight.ok).toBe(true);
    expect(outcome.children).toHaveLength(8);
    const envelopes = new Set(outcome.children.map((entry) => entry.child.envelope));
    const caseIds = new Set(outcome.children.map((entry) => entry.child.execution.caseId));
    expect(envelopes.size).toBe(8);
    expect(caseIds.size).toBe(8);
    for (const child of outcome.children) {
      expect(child.child.envelope).not.toBeNull();
      expect(child.child.identityAgrees).toBe(true);
      expect(child.durable.wrote).toBe(true);
    }
    expect(outcome.aggregation?.ok).toBe(true);
    expect(outcome.cli.details?.children).toHaveLength(8);
    expect(outcome.cli.details?.complete).toBe(true);
  });

  it('refuses a suite preflight before any child runs', () => {
    const members = preparedCases
      .slice(0, 7)
      .map((prepared, index) => suiteMember(prepared, index + 1));
    const outcome = runFinalSuiteActivePath(
      suiteRunInput({
        suiteId: 'representative',
        suiteVersion: 1,
        declaredCaseCount: 8,
        members,
      }),
    );
    expect(outcome.preflight.ok).toBe(false);
    expect(outcome.preflight.issues.join(' ')).toMatch(/SUITE_PREFLIGHT_COUNT_MISMATCH/);
    expect(outcome.children).toEqual([]);
    expect(outcome.cli.status).toBe('HARNESS_BLOCKED');
    expect(outcome.cli.launchAttempted).toBe(false);
  });

  it('aggregates a single-member PASS suite but a failed child record prevents PASS', () => {
    const prepared = preparedCases[0] as PreparedCase;
    const passMember = suiteMember(prepared, 1);
    const pass = runFinalSuiteActivePath(
      suiteRunInput({
        suiteId: 'representative',
        suiteVersion: 1,
        declaredCaseCount: 1,
        members: [
          { ...passMember, observation: observationOf(prepared, passTextPayload(prepared)) },
        ],
      }),
    );
    expect(pass.finalOutcome).toBe('PASS');
    expect(pass.cli.status).toBe('PASS');
    expect(pass.cli.details?.pass).toBe(true);
    expect(pass.cli.details?.failedRecordOrders).toEqual([]);
    expect(pass.cli.details?.suiteRecordPath).not.toBeNull();
    expect(pass.suite.record?.schemaVersion).toBe(2);

    const failed = runFinalSuiteActivePath(
      suiteRunInput({
        suiteId: 'representative',
        suiteVersion: 1,
        declaredCaseCount: 1,
        members: [
          {
            ...passMember,
            observation: observationOf(prepared, passTextPayload(prepared)),
            writeRecord: () => {
              throw new RunRecordExistsError('injected suite finalization failure');
            },
          },
        ],
      }),
    );
    expect(failed.cli.details?.failedRecordOrders).toEqual([1]);
    expect(failed.finalOutcome).toBe('ENVIRONMENT_FAILURE');
    expect(failed.cli.status).not.toBe('PASS');
    expect(failed.cli.details?.pass).toBe(false);
  });

  it('applies finalization precedence over a BUG aggregate without rewriting a child outcome', () => {
    const prepared = preparedCases[0] as PreparedCase;
    const outcome = runFinalSuiteActivePath(
      suiteRunInput({
        suiteId: 'representative',
        suiteVersion: 1,
        declaredCaseCount: 1,
        members: [
          {
            ...suiteMember(prepared, 1),
            observation: observationOf(prepared, bugTextPayload(prepared)),
          },
        ],
        writeSuiteRecord: () => {
          throw new RunRecordExistsError('injected aggregate write/readback failure');
        },
      }),
    );
    expect(outcome.aggregation?.ok).toBe(true);
    if (outcome.aggregation?.ok === true) {
      expect(outcome.aggregation.decision.finalStatus).toBe('BUG');
    }
    // The child's own BUG verdict is preserved verbatim while the failed required
    // aggregate write/readback outranks it as ENVIRONMENT_FAILURE.
    expect(outcome.children[0]?.child.execution.finalOutcome).toBe('BUG');
    expect(outcome.suite.durable.required).toBe(true);
    expect(outcome.suite.durable.wrote).toBe(false);
    expect(outcome.finalOutcome).toBe('ENVIRONMENT_FAILURE');
    expect(outcome.cli.status).toBe('ENVIRONMENT_FAILURE');
    expect(outcome.cli.details?.pass).toBe(false);
    expect(outcome.cli.details?.suiteRecordPath).toBeNull();
  });

  it('applies finalization precedence over a HARNESS_BLOCKED aggregation', () => {
    const mismatched = preparedCases[0] as PreparedCase;
    const failingWrite = preparedCases[1] as PreparedCase;
    const outcome = runFinalSuiteActivePath(
      suiteRunInput({
        suiteId: 'representative',
        suiteVersion: 1,
        declaredCaseCount: 2,
        members: [
          { ...suiteMember(mismatched, 1), caseId: 'b2e2-mismatched-case-id' },
          {
            ...suiteMember(failingWrite, 2),
            writeRecord: () => {
              throw new RunRecordExistsError('injected child write failure');
            },
          },
        ],
      }),
    );
    // The identity mismatch refuses the aggregation (HARNESS_BLOCKED) yet the
    // failed required child record still outranks it as ENVIRONMENT_FAILURE.
    expect(outcome.aggregation?.ok).toBe(false);
    expect(outcome.finalOutcome).toBe('ENVIRONMENT_FAILURE');
    expect(outcome.cli.status).toBe('ENVIRONMENT_FAILURE');
    expect(outcome.cli.details?.aggregateStatus).toBeNull();
    expect(outcome.cli.details?.failedRecordOrders).toEqual([2]);
  });

  it('refuses an aggregate context whose suite execution id aliases its lineage', () => {
    const prepared = preparedCases[0] as PreparedCase;
    const outcome = runFinalSuiteActivePath(
      suiteRunInput({
        suiteId: 'representative',
        suiteVersion: 1,
        declaredCaseCount: 1,
        members: [
          {
            ...suiteMember(prepared, 1),
            observation: observationOf(prepared, passTextPayload(prepared)),
          },
        ],
        aggregate: {
          ...SUITE_AGGREGATE_CONTEXT,
          suiteLineageId: SUITE_AGGREGATE_CONTEXT.suiteExecutionId,
        },
      }),
    );
    expect(outcome.finalOutcome).toBe('ENVIRONMENT_FAILURE');
    expect(outcome.cli.details?.suiteRecordPath).toBeNull();
    expect(outcome.suite.durable.error).toMatch(/lineage/i);
  });

  it('classifies a bounded child readback without aborting: I/O, malformed, mixed, legacy, identity', () => {
    const prepared = preparedCases[0] as PreparedCase;
    const seed = runFinalSuiteActivePath(
      suiteRunInput({
        suiteId: 'representative',
        suiteVersion: 1,
        declaredCaseCount: 1,
        members: [
          {
            ...suiteMember(prepared, 1),
            observation: observationOf(prepared, passTextPayload(prepared)),
          },
        ],
      }),
    );
    const seedPath = seed.children[0]?.durable.path as string;
    const seedText = readFileSync(seedPath, 'utf8');

    const root = tempEvidenceRoot();
    const crafted = (name: string, text: string): string => {
      const target = path.join(root, name);
      writeFileSync(target, text, 'utf8');
      return target;
    };
    const mutated = JSON.parse(seedText) as Record<string, unknown>;
    mutated.caseId = 'b2e2-mutated-case-id';

    const cases: readonly {
      readonly name: string;
      readonly path: string;
      readonly kind: string;
    }[] = [
      { name: 'unreadable', path: path.join(root, 'absent.json'), kind: 'unreadable' },
      { name: 'invalid', path: crafted('invalid.json', '{ not json'), kind: 'invalid' },
      { name: 'unknown', path: crafted('unknown.json', '{"schemaVersion":9}\n'), kind: 'unknown' },
      {
        name: 'mixed',
        path: crafted(
          'mixed.json',
          '{"schemaVersion":3,"checks":[{"checkId":"geometry.delta","status":"PASS"}]}\n',
        ),
        kind: 'mixed',
      },
      {
        name: 'legacy',
        path: crafted(
          'legacy.json',
          '{"schemaVersion":2,"checks":[{"checkId":"geometry.delta","passed":false}]}\n',
        ),
        kind: 'legacy',
      },
      {
        name: 'identity',
        path: crafted('identity.json', `${JSON.stringify(mutated)}\n`),
        kind: 'current-v4',
      },
    ];

    for (const entry of cases) {
      const outcome = runFinalSuiteActivePath(
        suiteRunInput({
          suiteId: 'representative',
          suiteVersion: 1,
          declaredCaseCount: 1,
          members: [
            {
              ...suiteMember(prepared, 1),
              observation: observationOf(prepared, passTextPayload(prepared)),
              writeRecord: (() => ({
                path: entry.path,
                serialized: 'b2e2-crafted',
                record: null,
              })) as never,
            },
          ],
        }),
      );
      expect(outcome.childReadback[0]?.kind, entry.name).toBe(entry.kind);
      expect(outcome.finalOutcome, entry.name).toBe('ENVIRONMENT_FAILURE');
      expect(outcome.cli.details?.suiteRecordPath, entry.name).toBeNull();
      expect(outcome.cli.details?.pass, entry.name).toBe(false);
    }

    // The identity case read back as a current record, then the bounded re-read
    // refused it because its identity disagreed with the compiled child identity.
    const identityOutcome = runFinalSuiteActivePath(
      suiteRunInput({
        suiteId: 'representative',
        suiteVersion: 1,
        declaredCaseCount: 1,
        members: [
          {
            ...suiteMember(prepared, 1),
            observation: observationOf(prepared, passTextPayload(prepared)),
            writeRecord: (() => ({
              path: crafted('identity-2.json', `${JSON.stringify(mutated)}\n`),
              serialized: seedText,
              record: null,
            })) as never,
          },
        ],
      }),
    );
    expect(identityOutcome.childReadback[0]?.kind).toBe('current-v4');
    expect(identityOutcome.suite.durable.error).toMatch(/identity/i);
    expect(identityOutcome.finalOutcome).toBe('ENVIRONMENT_FAILURE');
  });
});

// ── Doctor and production-absence command contexts ───────────────────────────

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

function productionObservation(
  attempt: 'initial' | 'reload',
  clean: boolean,
): ProductionBrowserObservation {
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

function productionFacts(options: { artifactClean?: boolean } = {}): CommandCheckFact[] {
  const hits =
    options.artifactClean === false
      ? scanArtifactContent(
          'dist/server/chunks/bridge.js',
          `window.${OBSERVATION_GLOBAL_MARKER} = {};`,
        )
      : scanArtifactContent('dist/server/chunks/app/page.js', 'export const x = 1;');
  const scan = { clean: hits.length === 0, hits };
  const initial = productionObservation('initial', true);
  const reload = productionObservation('reload', true);
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

function commandOperational(runId: string): FinalActivePathCommandOperationals {
  return {
    runId,
    launch: buildPublicLaunchFacts({
      attempted: true,
      pid: 4242,
      processGroupId: 4242,
      readinessMs: 812,
      serverLogPath: '/b2e2-fixture-scratch/b2e2-owned-run/server.log',
    }),
    ownership: buildEstablishedOwnership(
      { ...OWNERSHIP_FIXTURE, runId },
      'launched',
      `.next/verify-runs/${runId}`,
      '.pi/skills/verify-artwork-editor',
    ),
    cleanup: buildCleanupProjection({ ...CLEANUP_FIXTURE, runId }),
    diagnostics: [],
    runError: null,
    recordedAt: '2026-09-20T00:00:00.000Z',
  };
}

function runDoctorFaçade(overrides: {
  checks?: readonly CommandCheckFact[];
  evidence?: readonly CommandEvidenceFact[];
  commandAuthority?: CommandStatusAuthority;
  cleanupSucceeded?: boolean;
  writeRecord?: () => never;
}) {
  const runId = 'b2e2-doctor-run';
  return runFinalDoctorActivePath({
    input: {
      commandAuthority: overrides.commandAuthority ?? DOCTOR_COMMAND_STATUS_AUTHORITY,
      checks: overrides.checks ?? doctorFacts(),
      evidence:
        overrides.evidence ??
        DOCTOR_COMMAND_REQUIRED_EVIDENCE.map((evidenceId) => ({
          evidenceId,
          availability: 'authoritative' as const,
        })),
      cleanupSucceeded: overrides.cleanupSucceeded ?? true,
    },
    operational: commandOperational(runId),
    durable: { evidenceRoot: tempEvidenceRoot() },
    ...(overrides.writeRecord === undefined ? {} : { writeRecord: overrides.writeRecord }),
  });
}

describe('[P7-B2-E2] Doctor and production-absence command-context façade', () => {
  it('classifies and durably records both command contexts as command-v4 without a profile', () => {
    const doctor = runDoctorFaçade({});
    expect(doctor.execution.behaviorOutcome).toBe('PASS');
    expect(doctor.finalOutcome).toBe('PASS');
    expect(doctor.cli.status).toBe('PASS');
    expect(doctor.durable.wrote).toBe(true);
    const doctorRead = readFinalPublicRecordFile(doctor.durable.path as string);
    expect(doctorRead.kind).toBe('command-v4');
    if (doctorRead.record !== null && 'command' in doctorRead.record) {
      expect(doctorRead.record.command).toBe('doctor');
      expect(Object.hasOwn(doctorRead.record, 'resolvedProfileFingerprint')).toBe(false);
      expect(Object.hasOwn(doctorRead.record, 'harnessInvalid')).toBe(false);
    }
    expect(doctor.cli.details?.requiredChecks.map((check) => check.checkId)).toEqual([
      ...DOCTOR_CHECK_IDS,
    ]);

    const production = runFinalProductionAbsenceActivePath({
      input: {
        commandAuthority: PRODUCTION_ABSENCE_COMMAND_STATUS_AUTHORITY,
        checks: productionFacts(),
        evidence: PRODUCTION_ABSENCE_COMMAND_REQUIRED_EVIDENCE.map((evidenceId) => ({
          evidenceId,
          availability: 'authoritative' as const,
        })),
        cleanupSucceeded: true,
      },
      operational: commandOperational('b2e2-production-run'),
      durable: { evidenceRoot: tempEvidenceRoot() },
    });
    expect(production.finalOutcome).toBe('PASS');
    expect(production.cli.details?.requiredChecks.map((check) => check.checkId)).toEqual([
      ...PRODUCTION_CHECK_IDS,
    ]);
    expect(readFinalPublicRecordFile(production.durable.path as string).kind).toBe('command-v4');
  });

  it('maps a Doctor negative to BUG and an unavailable authority to HARNESS_BLOCKED', () => {
    const bug = runDoctorFaçade({ checks: doctorFacts({ 'doctor.bridge.methods': false }) });
    expect(bug.execution.behaviorOutcome).toBe('BUG');
    expect(bug.finalOutcome).toBe('BUG');
    expect(bug.cli.status).toBe('BUG');

    const unusable = runDoctorFaçade({
      checks: doctorFacts().filter((fact) => fact.checkId !== 'doctor.bridge.frozen'),
    });
    expect(unusable.finalOutcome).toBe('HARNESS_BLOCKED');
    expect(unusable.cli.status).toBe('HARNESS_BLOCKED');
  });

  it('refuses a foreign command authority pre-authority with no fabricated record', () => {
    const outcome = runDoctorFaçade({
      commandAuthority: PRODUCTION_ABSENCE_COMMAND_STATUS_AUTHORITY,
    });
    expect(outcome.execution.authoritative).toBe(false);
    expect(outcome.execution.preauthority).toBe(true);
    expect(outcome.execution.requiredChecks).toEqual([]);
    expect(outcome.execution.record).toBeNull();
    expect(outcome.durable.attempted).toBe(false);
    expect(outcome.cli.status).toBe('HARNESS_BLOCKED');
  });

  it('prevents a command PASS when its required record cannot be finalized', () => {
    const outcome = runDoctorFaçade({
      writeRecord: () => {
        throw new RunRecordExistsError('injected command finalization failure');
      },
    });
    expect(outcome.execution.finalOutcome).toBe('PASS');
    expect(outcome.durable.wrote).toBe(false);
    expect(outcome.finalOutcome).toBe('HARNESS_BLOCKED');
  });

  it('applies finalization precedence over a command BUG and HARNESS_BLOCKED', () => {
    const bug = runDoctorFaçade({
      checks: doctorFacts({ 'doctor.bridge.methods': false }),
      writeRecord: () => {
        throw new RunRecordExistsError('injected command finalization failure');
      },
    });
    expect(bug.execution.behaviorOutcome).toBe('BUG');
    expect(bug.execution.finalOutcome).toBe('BUG');
    expect(bug.durable.wrote).toBe(false);
    expect(bug.finalOutcome).toBe('HARNESS_BLOCKED');
    expect(bug.cli.status).toBe('HARNESS_BLOCKED');

    const blocked = runDoctorFaçade({
      checks: doctorFacts().filter((fact) => fact.checkId !== 'doctor.bridge.frozen'),
      writeRecord: () => {
        throw new RunRecordExistsError('injected command finalization failure');
      },
    });
    expect(blocked.execution.finalOutcome).toBe('HARNESS_BLOCKED');
    expect(blocked.execution.record).not.toBeNull();
    expect(blocked.durable.wrote).toBe(false);
    expect(blocked.finalOutcome).toBe('HARNESS_BLOCKED');
    expect(blocked.cli.status).toBe('HARNESS_BLOCKED');
  });

  it('never imports or fabricates a compiled correctness profile on a command path', () => {
    for (const outcome of [runDoctorFaçade({}).execution]) {
      expect(Object.hasOwn(outcome, 'resolvedProfile')).toBe(false);
      for (const check of outcome.requiredChecks) {
        expect(Object.hasOwn(check, 'actionCycleRef')).toBe(false);
        expect(Object.hasOwn(check, 'passed')).toBe(false);
      }
    }
    expect(DOCTOR_COMMAND_AUTHORITY.command).toBe('doctor');
    expect(PRODUCTION_ABSENCE_COMMAND_AUTHORITY.command).toBe('production-absence');
  });
});

// ── Static boundary: no flag, cache, disk lookup, or route selector ──────────

describe('[P7-B2-E2] current façade boundary and no activation mechanism', () => {
  const source = (relative: string): string => readFileSync(path.join(skillRoot, relative), 'utf8');
  const FACADE_FILES = [
    'src/orchestration/final-active-path.ts',
    'src/orchestration/final-switch-manifest.ts',
  ];

  it('declares no runtime flag, mutable global cache, disk profile lookup, or route selector', () => {
    for (const relative of FACADE_FILES) {
      const text = source(relative);
      expect(text, relative).not.toContain('node:fs');
      expect(text, relative).not.toContain('process.env');
      expect(text, relative).not.toContain('globalThis');
      expect(text, relative).not.toMatch(/(feature|cutover|activation)Flag/i);
      expect(text, relative).not.toMatch(
        /scenario\s*===|subjectId\s*===|\bfamily\s*===|route\s*===/,
      );
      expect(text, relative).not.toMatch(/^(let|var)\s/m);
      expect(text, relative).not.toContain('readFileSync');
    }
  });

  it('imports no active CLI, runtime classifier, browser, Oracle, adapter, or old writer', () => {
    for (const relative of FACADE_FILES) {
      const text = source(relative);
      expect(text, relative).not.toContain("from '../cli/");
      expect(text, relative).not.toContain("from '../browser/");
      expect(text, relative).not.toContain("from '../oracles/");
      expect(text, relative).not.toContain("from '../runtime/outcomes'");
      expect(text, relative).not.toContain("from '../runtime/execute'");
      expect(text, relative).not.toContain("from '../evidence/writer'");
      expect(text, relative).not.toContain("from '../evidence/reader'");
      expect(text, relative).not.toContain("from '../evidence/public-dto'");
    }
    // The façade consumes the executor-owned observation only as a type; it
    // writes through the current strict-v4 final writer.
    expect(source('src/orchestration/final-active-path.ts')).toMatch(
      /import type \{ FinalExecutionObservation \} from '\.\.\/runtime\/execute-plan';/,
    );
    expect(source('src/orchestration/final-active-path.ts')).toContain(
      "from '../evidence/final-writer'",
    );
  });

  it('is reached by exactly the four active CLI entries and no other active boundary', () => {
    const activeEntries = [...FINAL_SWITCH_MANIFEST.activeCliEntries];
    for (const entry of activeEntries) {
      expect(source(entry), entry).toContain('orchestration/final-active-path');
    }
    for (const relative of [
      'src/cli/main.ts',
      'src/runtime/execute-plan.ts',
      'src/runtime/action-cycle.ts',
      'src/runtime/outcomes.ts',
      'src/runtime/result-outcome.ts',
      'src/evidence/writer.ts',
      'src/evidence/reader.ts',
      'src/evidence/public-dto.ts',
      'src/evidence/suite-record.ts',
      'src/browser/doctor.ts',
      'src/browser/production-absence.ts',
      'src/index.ts',
    ]) {
      const text = source(relative);
      for (const marker of FINAL_SWITCH_FACADE_MARKERS) {
        expect(text, `active module ${relative} references ${marker}`).not.toContain(marker);
      }
    }
  });
});

// ── Frozen switch manifest closure ───────────────────────────────────────────

function repositoryView(): FinalSwitchManifestView {
  const read = (dir: string, prefix: string) => {
    const files: { path: string; text: string }[] = [];
    const walk = (current: string): void => {
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        const target = path.join(current, entry.name);
        if (entry.isDirectory()) {
          walk(target);
          continue;
        }
        if (!entry.name.endsWith('.ts')) continue;
        files.push({
          path: `${prefix}/${path.relative(dir, target)}`,
          text: readFileSync(target, 'utf8'),
        });
      }
    };
    walk(dir);
    return files;
  };
  return {
    sourceFiles: read(path.join(skillRoot, 'src'), 'src'),
    testFiles: read(path.join(skillRoot, 'tests'), 'tests'),
    fixturePaths: FINAL_SWITCH_HISTORICAL_FIXTURES.filter((relative) =>
      existsSync(path.join(repoRoot, relative)),
    ),
  };
}

describe('[P7-B2-E2] frozen B2-E3 switch manifest completeness', () => {
  it('is frozen and enumerates every required closure category', () => {
    expect(Object.isFrozen(FINAL_SWITCH_MANIFEST)).toBe(true);
    expect(FINAL_SWITCH_MANIFEST.manifestVersion).toBe(1);
    expect(FINAL_SWITCH_MANIFEST.activeCliEntries).toHaveLength(4);
    expect(FINAL_SWITCH_MANIFEST.removedPublicExports).toEqual(
      expect.arrayContaining(['CheckResult', 'classifyOutcome', 'writePublicRunRecordV3']),
    );
    expect(FINAL_SWITCH_MANIFEST.forbiddenImportEdges.length).toBeGreaterThanOrEqual(6);
    expect(FINAL_SWITCH_MANIFEST.activationImportEdges.map((edge) => edge.from)).toEqual([
      ...FINAL_SWITCH_MANIFEST.activeCliEntries,
    ]);
    expect(
      FINAL_SWITCH_MANIFEST.activationImportEdges.every(
        (edge) => edge.to === 'src/orchestration/final-active-path.ts',
      ),
    ).toBe(true);
    expect(FINAL_SWITCH_MANIFEST.retentionConstraints.length).toBeGreaterThan(0);
    expect(FINAL_SWITCH_MANIFEST.historicalFixtures).toEqual([...FINAL_SWITCH_HISTORICAL_FIXTURES]);
    expect(FINAL_SWITCH_MANIFEST.excludedBoundaries.length).toBeGreaterThan(0);
    // The narrowed write set never touches the excluded product/catalogue space.
    for (const excluded of ['catalogues/', 'cases/', 'src/lib/']) {
      expect(FINAL_SWITCH_MANIFEST.b2e3WriteSet.some((entry) => entry.includes(excluded))).toBe(
        false,
      );
    }
  });

  it('passes its own closure audit against the real repository view', () => {
    const issues = finalSwitchManifestIssues(repositoryView());
    expect(issues.map((entry) => entry.code)).toEqual([]);
  });

  it('reports an unaccounted old-authority importer, a reached façade, and a missing fixture', () => {
    const view = repositoryView();
    const injected: FinalSwitchManifestView = {
      sourceFiles: [
        ...view.sourceFiles,
        {
          path: 'src/cli/rogue-new-entry.ts',
          text: "import { classifyOutcome } from '../runtime/outcomes';\n",
        },
      ],
      testFiles: view.testFiles,
      fixturePaths: [],
    };
    const codes = finalSwitchManifestIssues(injected).map((entry) => entry.code);
    expect(codes).toContain('MANIFEST_SRC_CLOSURE_INCOMPLETE');
    expect(codes).toContain('MANIFEST_FIXTURE_MISSING');

    const reached: FinalSwitchManifestView = {
      sourceFiles: view.sourceFiles.map((file) =>
        file.path === 'src/cli/diagnostic.ts'
          ? {
              ...file,
              text: "import { runFinalDiagnosticActivePath } from '../orchestration/final-active-path';\n",
            }
          : file,
      ),
      testFiles: view.testFiles,
      fixturePaths: view.fixturePaths,
    };
    expect(finalSwitchManifestIssues(reached).map((entry) => entry.code)).toContain(
      'MANIFEST_ACTIVATION_EDGE_ABSENT',
    );
  });

  it('accounts for every active importer of the old result authority', () => {
    const view = repositoryView();
    const oldAuthorityModules = FINAL_SWITCH_MANIFEST.oldAuthorityModules;
    const covered = new Set([
      ...FINAL_SWITCH_MANIFEST.activeCliEntries,
      ...FINAL_SWITCH_MANIFEST.dynamicDispatchFiles,
      ...FINAL_SWITCH_MANIFEST.diagnosticProducerFiles,
      ...FINAL_SWITCH_MANIFEST.commandProducerFiles,
      ...FINAL_SWITCH_MANIFEST.contractsEvidenceFiles,
      ...FINAL_SWITCH_MANIFEST.plannerOrchestrationFiles,
      ...FINAL_SWITCH_MANIFEST.publicBarrelFiles,
      ...FINAL_SWITCH_MANIFEST.auditedDependencyFiles,
      ...FINAL_SWITCH_MANIFEST.retainedReadOnlyFiles,
      ...FINAL_SWITCH_MANIFEST.typeOnlyEdges,
    ]);
    const importerPattern = (module: string): RegExp =>
      new RegExp(`from\\s+['"][^'"]*${module.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]`);
    const importers = view.sourceFiles
      .filter(
        (file) =>
          !oldAuthorityModules.includes(file.path) &&
          !FINAL_SWITCH_MANIFEST.finalAuthorityFiles.includes(file.path) &&
          oldAuthorityModules.some((module) =>
            importerPattern(module.replace('src/', '').replace(/\.ts$/, '')).test(file.text),
          ),
      )
      .map((file) => file.path);
    for (const importer of importers) {
      expect(covered.has(importer), `manifest covers ${importer}`).toBe(true);
    }
    expect(importers.length).toBeGreaterThan(0);
  });

  it('retains the boolean baseline while the barrel exposes only the final current surfaces', () => {
    const source = (relative: string): string =>
      readFileSync(path.join(skillRoot, relative), 'utf8');
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
    for (const marker of ['orchestration/', 'final-active-path', 'final-switch-manifest']) {
      expect(barrel, marker).not.toContain(marker);
    }
  });
});

// ── Public v4 path is never reachable from the active barrel ─────────────────

describe('[P7-B2-E2] no active behavior change', () => {
  it('leaves the active CLI/runtime/evidence entry points byte-identical to the accepted baseline', () => {
    // The façade changes no active entry; a spot check of the retained authority
    // contracts and the absence of façade markers in the barrel proves the
    // inactive boundary.
    const markers = [...FINAL_SWITCH_FACADE_MARKERS];
    const barrel = readFileSync(path.join(skillRoot, 'src/index.ts'), 'utf8');
    for (const marker of markers) expect(barrel).not.toContain(marker);
    expect(
      FINAL_SWITCH_MANIFEST.activeCliEntries.every((entry) =>
        existsSync(path.join(skillRoot, entry)),
      ),
    ).toBe(true);
  });

  it('keeps the public-path mirror equal to the active public contract', () => {
    expect(PUBLIC_PATH_REF_DOMAIN).toBe('makeit:public-path-ref:v1');
    expect([...PUBLIC_PATH_ROLES]).toEqual([
      'repository',
      'skill-root',
      'next-dist-dir',
      'scratch-root',
      'evidence-root',
      'server-log',
      'downloads',
      'temp',
      'config',
      'snapshot',
    ]);
  });
});
