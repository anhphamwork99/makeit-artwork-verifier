import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { evaluateCrosswordLiveChecks } from '../../src/adapters/crossword-live-facts';
import { evaluateHistoryLiveChecks } from '../../src/adapters/history-live-facts';
import { evaluateImageLiveChecks } from '../../src/adapters/image-live-facts';
import { evaluateNestedObjectLiveChecks } from '../../src/adapters/object-live-facts';
import { evaluateRestoreLiveChecks } from '../../src/adapters/restore-live-facts';
import {
  evaluateOrdinaryTextLiveChecks,
  evaluateWarpedTextLiveChecks,
  projectOrdinaryTextLiveFact,
} from '../../src/adapters/text-live-facts';
import { deriveWorkflowStepCatalogueFingerprint } from '../../src/catalogue/fingerprint';
import { loadCatalogueBundle, type CatalogueBundle } from '../../src/catalogue/load';
import { loadDiagnosticSuite, resolveSuiteRequests } from '../../src/catalogue/suite';
import type {
  ActionCycleCorrectnessIdentity,
  CorrectnessCheckResult,
  ResolvedCorrectnessProfile,
} from '../../src/contracts/correctness';
import type { Capability, Outcome } from '../../src/contracts/discriminants';
import {
  assembleFinalChildRecordV4,
  finalRecordLegacyAuthorityIssues,
  type FinalCurrentChildRecordV4,
  type FinalNestedProjectionV4,
} from '../../src/contracts/final-record-v4';
import {
  FINAL_PUBLIC_PATH_REF_DOMAIN,
  FINAL_PUBLIC_PATH_ROLES,
  FINAL_PUBLIC_RUN_RECORD_KEYS,
  assembleFinalPublicCommandRecordV4,
  assembleFinalPublicRunRecordV4,
  readFinalPublicRecord,
  validateFinalPublicCommandRecordV4,
  validateFinalPublicRecordV4,
  validateFinalPublicRunRecordV4,
  type AssembleFinalPublicRunRecordV4Input,
  type FinalPublicRunRecordV4,
} from '../../src/contracts/final-public-record';
import type { CleanupResult, RunOwnershipRecord } from '../../src/contracts/runtime';
import { CHECK_RESULT_CONTRACT_SCHEMA_VERSION } from '../../src/contracts/schema-versions';
import { readFinalPublicRecordFile } from '../../src/evidence/final-reader';
import {
  prepareFinalPublicCommandRecordV4,
  prepareFinalPublicRunRecordV4,
  readBackFinalPublicCommandRecordV4,
  readBackFinalPublicRunRecordV4,
  serializePreparedFinalPublicCommandRecordV4,
  serializePreparedFinalPublicRunRecordV4,
  writeFinalPublicCommandRecordV4,
  writeFinalPublicRunRecordV4,
  type WriteFinalPublicCommandRecordV4Input,
} from '../../src/evidence/final-writer';
import { isRedactionRejected, serializePublicRecord } from '../../src/evidence/guard';
import {
  PUBLIC_PATH_REF_DOMAIN,
  PUBLIC_PATH_ROLES,
  buildCleanupProjection,
  buildEstablishedOwnership,
  buildNotEstablishedOwnership,
  buildPublicLaunchFacts,
} from '../../src/evidence/public-dto';
import { RunRecordExistsError, RunRecordWriteError } from '../../src/evidence/writer';
import {
  DOCTOR_COMMAND_CHECKS,
  DOCTOR_COMMAND_REQUIRED_EVIDENCE,
  DOCTOR_COMMAND_STATUS_AUTHORITY,
  PRODUCTION_ABSENCE_COMMAND_CHECKS,
  PRODUCTION_ABSENCE_COMMAND_REQUIRED_EVIDENCE,
  PRODUCTION_ABSENCE_COMMAND_STATUS_AUTHORITY,
  evaluateGeometryDeltaOracle,
} from '../../src/index';
import { executeDoctorCommandContext } from '../../src/orchestration/doctor-command-execution';
import { executeProductionAbsenceCommandContext } from '../../src/orchestration/production-absence-command-execution';
import { planCaseForExecution, type PlanForExecutionResult } from '../../src/planner/plan-case';
import type { MaterializedExecutionEnvelopeV1 } from '../../src/planner/execution-materialization';
import { DEFAULT_ENVIRONMENT_CELL_ID } from '../../src/runtime/environment';
import { resolveSkillRoot } from '../../src/runtime/paths';

/**
 * P7-B2-E1 focused proof: inactive durable strict-v4 public evidence port
 * (ADR 0030 §B2-E1, ADR 0029 §4 B2-E1, ADR 0025 §7).
 *
 * The suites drive the complete public v4 DTO from the *real* exact envelopes
 * produced by `planCaseForExecution` and the *real* inactive per-family
 * live-fact adapters, prove a complete closed public record for every
 * representative family, prove every nested projection carries v4 status checks
 * with resolved Action Cycle references, prove the operational ownership,
 * cleanup, launch, repository, contract and diagnostic projections are
 * preserved exactly, prove recursive rejection of `passed`/`harnessInvalid`
 * anywhere in the record, prove the redaction and exclusive-write boundaries,
 * prove strict self-readback, prove unknown/malformed/legacy discrimination, and
 * prove the inactive import boundary and the frozen active boolean/v3 baseline.
 *
 * Every durable write in this file targets an isolated temporary directory. No
 * accepted run or suite evidence is written and no active evidence location is
 * reachable from the port.
 */

const skillRoot = resolveSkillRoot();
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

/** Accepted B1 representative plan identities; the public record must not move any. */
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
      actionCycleId: `b2e1-cycle-${fileName}`,
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

function requireChecks(outcome: {
  ok: boolean;
  result?: { checks: readonly CorrectnessCheckResult[] };
}): readonly CorrectnessCheckResult[] {
  if (!outcome.ok || outcome.result === undefined) throw new Error('family adapter failed');
  return outcome.result.checks;
}

/** The seven accepted evaluator families, each from its exact envelope + adapter + kernel. */
function checksFor(prepared: PreparedCase): readonly CorrectnessCheckResult[] {
  const { envelope, route, actionCycle, profile } = prepared;
  switch (profile.oracle.evaluatorKind) {
    case 'geometry-delta':
      return requireChecks(
        evaluateOrdinaryTextLiveChecks({
          envelope,
          route,
          actionCycle,
          minimumDelta: null,
          delta: null,
          evidence: [],
        }),
      );
    case 'warped-text-envelope':
      return requireChecks(
        evaluateWarpedTextLiveChecks({
          envelope,
          route,
          actionCycle,
          minimumDelta: null,
          oracle: null,
          evidence: [],
        }),
      );
    case 'nested-object-affine':
      return requireChecks(
        evaluateNestedObjectLiveChecks({
          envelope,
          route,
          actionCycle,
          minimumDelta: null,
          oracle: null,
          evidence: [],
        }),
      );
    case 'image-upload-replace':
      return requireChecks(
        evaluateImageLiveChecks({
          envelope,
          route,
          actionCycle,
          mode: 'upload',
          targetId: 'b2e1-image-target',
          expectedLayoutId: 'b2e1-image-layout',
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
          readiness: readinessPolicy(profile) as never,
          evidence: [],
        }),
      );
    case 'crossword-determinism':
      return requireChecks(
        evaluateCrosswordLiveChecks({
          envelope,
          route,
          actionCycle,
          clock: null,
          sourceFingerprintExpected: '',
          executions: [],
          oracle: null,
          evidence: [],
        }),
      );
    case 'history-cross-subject':
      return requireChecks(
        evaluateHistoryLiveChecks({
          envelope,
          route,
          actionCycle,
          retainedLayoutId: null,
          setup: [],
          actions: [],
          finalHistory: null,
          readiness: readinessPolicy(profile) as never,
          oracle: null,
          evidence: [],
        }),
      );
    case 'frontend-restore':
      return requireChecks(
        evaluateRestoreLiveChecks({
          envelope,
          route,
          actionCycle,
          schemaVersion: 1,
          transition: {},
          meaning: {},
          rawSemantics: {},
          source: null,
          restored: null,
          setup: [],
          readiness: readinessPolicy(profile) as never,
          oracle: null,
          evidence: [],
        }),
      );
  }
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

/** Builds the exact nested projections the current public contract requires per family. */
function nestedProjectionsFor(
  prepared: PreparedCase,
  checks: readonly CorrectnessCheckResult[],
): FinalNestedProjectionV4[] {
  const actionCycle = prepared.actionCycle;
  const projections: FinalNestedProjectionV4[] = [actionCycleProjection(prepared)];
  switch (prepared.profile.oracle.evaluatorKind) {
    case 'image-upload-replace':
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
      break;
    case 'crossword-determinism':
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
          hostLayoutId: 'b2e1-crossword-host',
          createdTargetId: 'b2e1-crossword-target',
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
      break;
    case 'history-cross-subject':
      projections.push({
        schemaVersion: 4,
        family: 'history',
        normalizationProfileId: 'artwork-product-meaning-v1',
        readinessProfileId: prepared.profile.readiness.profileId,
        oracleProfileId: prepared.profile.oracle.oracleProfileId,
        timingCategory: prepared.profile.readiness.deadlineCategory,
        deadlineMs: prepared.profile.readiness.deadlineMs,
        retainedLayoutId: 'b2e1-history-layout',
        finalHistory: { pastDepth: 0, futureDepth: 0, baselineClean: true },
        actionCycleRef: actionCycle.actionCycleId,
        checks,
      });
      break;
    case 'frontend-restore':
      projections.push({
        schemaVersion: 4,
        family: 'restore',
        normalizationProfileId: 'artwork-product-meaning-v1',
        readinessProfileId: prepared.profile.readiness.profileId,
        oracleProfileId: prepared.profile.oracle.oracleProfileId,
        timingCategory: prepared.profile.readiness.deadlineCategory,
        deadlineMs: prepared.profile.readiness.deadlineMs,
        scenarioId: 'serialize-roundtrip',
        sourceDocumentId: 'b2e1-restore-source',
        restoredDocumentId: 'b2e1-restore-restored',
        actionCycleRef: actionCycle.actionCycleId,
        checks,
      });
      break;
    default:
      break;
  }
  return projections;
}

function childRecordFor(prepared: PreparedCase): FinalCurrentChildRecordV4 {
  const checks = checksFor(prepared);
  const assembled = assembleFinalChildRecordV4({
    envelope: prepared.envelope,
    runId: `b2e1-run-${prepared.fileName}`,
    observationId: null,
    actionCycles: [prepared.actionCycle],
    requiredChecks: checks,
    nestedProjections: nestedProjectionsFor(prepared, checks),
  });
  if (!assembled.ok) {
    throw new Error(
      `${prepared.fileName} strict v4 child assembly failed: ${assembled.issues
        .map((entry) => entry.code)
        .join(', ')}`,
    );
  }
  return assembled.record;
}

// ── Safe operational fixtures (accepted public builders) ─────────────────────

const OWNERSHIP_FIXTURE: RunOwnershipRecord = {
  runId: 'b2e1-owned-run',
  repoRoot: '/b2e1-fixture-repo',
  skillRoot: '/b2e1-fixture-repo/.pi/skills/verify-artwork-editor',
  repoRelativeDistDir: '.next/verify-runs/b2e1-owned-run',
  distDir: '/b2e1-fixture-repo/.next/verify-runs/b2e1-owned-run',
  scratchRoot: '/b2e1-fixture-scratch/b2e1-owned-run',
  evidenceRoot: '/b2e1-fixture-evidence/b2e1-owned-run',
  routeNamespace: 'b2e1-route-namespace',
  storageNamespace: 'b2e1-storage-namespace',
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
  serverLogPath: '/b2e1-fixture-scratch/b2e1-owned-run/server.log',
  repoConfigSnapshot: null,
  activeCase: null,
};

const CLEANUP_FIXTURE: CleanupResult = {
  schemaVersion: 1,
  runId: 'b2e1-owned-run',
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

function operationalFor(
  prepared: PreparedCase,
  overrides: Partial<Omit<AssembleFinalPublicRunRecordV4Input, 'child'>> = {},
): Omit<AssembleFinalPublicRunRecordV4Input, 'child'> {
  const contracts = prepared.planning.materializedCase.contracts;
  const route = prepared.planning.materializedCase.route;
  const fixture = prepared.planning.materializedCase.fixture;
  const profile = prepared.profile;
  const runId = `b2e1-run-${prepared.fileName}`;
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
        ? { fixtureId: 'b2e1-no-fixture', constructorId: 'b2e1-none', constructorVersion: 1 }
        : {
            fixtureId: fixture.fixtureId,
            constructorId: fixture.constructorId,
            constructorVersion: fixture.constructorVersion,
          },
    targets: [{ role: 'b2e1-target-role', elementId: 'b2e1-target-element' }],
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
    behaviorOutcome: 'HARNESS_BLOCKED',
    finalOutcome: 'HARNESS_BLOCKED',
    launch: buildPublicLaunchFacts({
      attempted: true,
      pid: 4242,
      processGroupId: 4242,
      readinessMs: 812,
      serverLogPath: '/b2e1-fixture-scratch/b2e1-owned-run/server.log',
    }),
    ownership: buildEstablishedOwnership(
      { ...OWNERSHIP_FIXTURE, runId },
      'launched',
      `.next/verify-runs/${runId}`,
      '.pi/skills/verify-artwork-editor',
    ),
    cleanup: buildCleanupProjection({ ...CLEANUP_FIXTURE, runId }),
    diagnostics: [
      {
        code: 'EVIDENCE_REDACTION_REJECTED',
        severity: 'warning',
        detail: 'b2e1 diagnostic fixture',
        subjectId: 'b2e1-subject',
        applicationKind: null,
        context: { issueCode: 'B2E1_FIXTURE' },
      },
    ],
    runError: null,
    recordedAt: '2026-09-20T00:00:00.000Z',
    ...overrides,
  };
}

function publicRecordFor(prepared: PreparedCase): FinalPublicRunRecordV4 {
  const assembled = assembleFinalPublicRunRecordV4({
    child: childRecordFor(prepared),
    ...operationalFor(prepared),
  });
  if (!assembled.ok) {
    throw new Error(
      `${prepared.fileName} public v4 assembly failed: ${assembled.issues
        .map((entry) => entry.code)
        .join(', ')}`,
    );
  }
  return assembled.record;
}

const preparedCases: readonly PreparedCase[] = REPRESENTATIVE_FILES.map((fileName) =>
  prepare(fileName),
);

// ── Isolated temporary evidence roots ────────────────────────────────────────

const createdRoots: string[] = [];

function tempEvidenceRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'p7b-b2e1-'));
  createdRoots.push(root);
  return root;
}

afterAll(() => {
  for (const root of createdRoots) rmSync(root, { recursive: true, force: true });
});

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Sets one dotted path in a deep clone of a public record (test mutation only). */
function mutateRecord<T>(record: T, dotted: string, value: unknown): T {
  const clone = deepClone(record) as unknown as Record<string, unknown>;
  const tokens = dotted.split('.');
  let cursor: Record<string, unknown> = clone;
  for (let index = 0; index < tokens.length - 1; index += 1) {
    cursor = cursor[tokens[index] as string] as Record<string, unknown>;
  }
  cursor[tokens[tokens.length - 1] as string] = value;
  return clone as unknown as T;
}

function issueCodes(result: { ok: boolean; issues?: readonly { code: string }[] }): string[] {
  return result.ok ? [] : (result.issues ?? []).map((entry) => entry.code);
}

/** Builds a `depth`-deep plain-record chain ending at `leaf` (test fixture only). */
function nestedChain(depth: number, leaf: unknown): Record<string, unknown> {
  let node: unknown = leaf;
  for (let level = 0; level < depth; level += 1) node = { level, next: node };
  return node as Record<string, unknown>;
}

function walkKeys(
  value: unknown,
  visit: (key: string, path: string) => void,
  prefix = 'record',
): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      walkKeys(entry, visit, `${prefix}[${index}]`);
    });
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    visit(key, `${prefix}.${key}`);
    walkKeys(child, visit, `${prefix}.${key}`);
  }
}

// ── Complete closed public v4 DTO for every representative family ────────────

describe('[P7-B2-E1] complete public v4 DTO for every representative plan and family', () => {
  it('exposes exactly the eight accepted representative requests at their accepted identities', () => {
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
    }
    expect(new Set(preparedCases.map((p) => p.envelope.planFingerprint)).size).toBe(8);
  });

  it('assembles and reads one complete closed public v4 record per representative plan', () => {
    expect(preparedCases).toHaveLength(8);
    for (const prepared of preparedCases) {
      const record = publicRecordFor(prepared);
      expect(validateFinalPublicRunRecordV4(record).ok, prepared.fileName).toBe(true);
      expect(validateFinalPublicRecordV4(record).ok, prepared.fileName).toBe(true);
      expect(record.schemaVersion).toBe(4);
      expect(record.command).toBe('diagnostic');
      expect(record.runId).toBe(`b2e1-run-${prepared.fileName}`);
      expect(record.caseId).toBe(prepared.baseline.caseId);
      expect(record.materializationFingerprint).toBe(prepared.baseline.materializationFingerprint);
      expect(record.planFingerprint).toBe(prepared.baseline.planFingerprint);
      expect(record.profile).toBe(prepared.baseline.profileId);
      expect(record.resolvedProfileFingerprint).toBe(
        prepared.baseline.correctnessProfileFingerprint,
      );
      expect(record.componentFingerprints).toEqual(prepared.profile.componentFingerprints);
      expect(record.requiredChecks.map((check) => check.checkId)).toEqual([
        ...prepared.baseline.requiredChecks,
      ]);
      expect(Object.isFrozen(record)).toBe(true);
      const read = readFinalPublicRecord(JSON.parse(JSON.stringify(record)) as unknown);
      expect(read.kind, prepared.fileName).toBe('current-v4');
      if (read.kind !== 'current-v4') continue;
      expect(read.legacy).toBe(false);
      expect(read.current).toBe(true);
      expect(read.ambiguous).toBe(false);
      expect(read.record).toEqual(record);
      expect(read.issues).toEqual([]);
    }
  });

  it('carries only three-state v4 required checks with resolved Action Cycle references', () => {
    for (const prepared of preparedCases) {
      const record = publicRecordFor(prepared);
      expect(record.requiredChecks.length).toBeGreaterThan(0);
      for (const check of record.requiredChecks) {
        expect(['PASS', 'FAIL', 'UNUSABLE']).toContain(check.status);
        expect(check.actionCycleRef).toBe(prepared.actionCycle.actionCycleId);
        expect(Object.hasOwn(check, 'passed')).toBe(false);
        expect(Object.hasOwn(check, 'harnessInvalid')).toBe(false);
        expect(check.consumedComponentFingerprints.resolvedProfile).toBe(
          prepared.baseline.correctnessProfileFingerprint,
        );
      }
      expect(record.actionCycles).toEqual([prepared.actionCycle]);
    }
  });

  it('carries every applicable nested v4 projection with v4 status checks', () => {
    const EXPECTED: Readonly<Record<string, readonly string[]>> = {
      'layer-text-move-drag-ordinary.json': ['action-cycle'],
      'layer-text-move-drag-warped-nested.json': ['action-cycle'],
      'container-object-move-nested-rotated.json': ['action-cycle'],
      'layer-image-upload-replace.json': ['action-cycle', 'image'],
      'layer-crossword-create.json': ['action-cycle', 'crossword'],
      'artwork-editor-history-undo-redo.json': ['action-cycle', 'history'],
      'artwork-editor-serialize-restore-normalized.json': ['action-cycle', 'restore'],
      'artwork-editor-serialize-restore-mixed-raw.json': ['action-cycle', 'restore'],
    };
    for (const prepared of preparedCases) {
      const record = publicRecordFor(prepared);
      expect(record.nestedProjections.map((entry) => entry.family).sort()).toEqual(
        [...(EXPECTED[prepared.fileName] as readonly string[])].sort(),
      );
      for (const projection of record.nestedProjections) {
        expect(projection.schemaVersion).toBe(4);
        if (projection.family === 'action-cycle') {
          expect(projection.actionCycles).toEqual(record.actionCycles);
          continue;
        }
        const checkLists: readonly CorrectnessCheckResult[][] =
          projection.family === 'image'
            ? projection.cycles.map((cycle) => [...cycle.checks])
            : projection.family === 'crossword'
              ? projection.executions.map((execution) => [...execution.checks])
              : [[...projection.checks]];
        for (const list of checkLists) {
          expect(list.length).toBeGreaterThan(0);
          for (const check of list) {
            expect(['PASS', 'FAIL', 'UNUSABLE']).toContain(check.status);
            expect(check.actionCycleRef).toBe(prepared.actionCycle.actionCycleId);
            expect(Object.hasOwn(check, 'passed')).toBe(false);
          }
        }
      }
    }
  });

  it('preserves the safe operational projections exactly and without legacy authority', () => {
    for (const prepared of preparedCases) {
      const operational = operationalFor(prepared);
      const record = publicRecordFor(prepared);
      expect(record.provenance).toBe(operational.provenance);
      expect(record.evidenceDepth).toBe(operational.evidenceDepth);
      expect(record.environmentCellId).toBe(DEFAULT_ENVIRONMENT_CELL_ID);
      expect(record.repository).toEqual(operational.repository);
      expect(record.fingerprints).toEqual(operational.fingerprints);
      expect(record.adapter).toEqual(operational.adapter);
      expect(record.workflow).toEqual(operational.workflow);
      expect(record.fixture).toEqual(operational.fixture);
      expect(record.targets).toEqual(operational.targets);
      expect(record.readiness).toEqual(operational.readiness);
      expect(record.launch).toEqual(operational.launch);
      expect(record.ownership).toEqual(operational.ownership);
      expect(record.cleanup).toEqual(operational.cleanup);
      expect(record.diagnostics).toEqual(operational.diagnostics);
      expect(record.runError).toBeNull();
      expect(record.behaviorOutcome).toBe('HARNESS_BLOCKED');
      expect(record.finalOutcome).toBe('HARNESS_BLOCKED');
      // The operational projections carry no recovered legacy authority.
      walkKeys(record, (key, at) => {
        expect(key, at).not.toBe('passed');
        expect(key, at).not.toBe('harnessInvalid');
      });
      expect(Object.hasOwn(record, 'harnessInvalid')).toBe(false);
    }
  });

  it('preserves an unestablished ownership refusal without fabricating ownership', () => {
    const prepared = preparedCases[0] as PreparedCase;
    const record = publicRecordFor(prepared);
    const refused = assembleFinalPublicRunRecordV4({
      child: childRecordFor(prepared),
      ...operationalFor(prepared, {
        ownership: buildNotEstablishedOwnership({
          runId: 'b2e1-refused-run',
          allocationFailureCode: 'PORT_UNAVAILABLE',
          requestedPort: 4321,
        }),
        cleanup: null,
        launch: buildPublicLaunchFacts({
          attempted: false,
          pid: null,
          processGroupId: null,
          readinessMs: null,
          serverLogPath: null,
        }),
      }),
    });
    expect(refused.ok, issueCodes(refused).join(', ')).toBe(true);
    if (!refused.ok) return;
    expect(refused.record.ownership.status).toBe('not-established');
    expect(refused.record.cleanup).toBeNull();
    expect(refused.record.launch.attempted).toBe(false);
    expect(record.ownership.status).toBe('established');
  });

  it('produces a real PASS public v4 record from the ordinary-Text oracle', () => {
    const prepared = preparedCases[0] as PreparedCase;
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
    expect(outcome.result.checks.every((check) => check.status === 'PASS')).toBe(true);
    const child = assembleFinalChildRecordV4({
      envelope: prepared.envelope,
      runId: 'b2e1-run-text-pass',
      observationId: 'b2e1-observation',
      actionCycles: [prepared.actionCycle],
      requiredChecks: outcome.result.checks,
      nestedProjections: [actionCycleProjection(prepared)],
    });
    if (!child.ok) throw new Error('expected strict v4 child assembly');
    const assembled = assembleFinalPublicRunRecordV4({
      child: child.record,
      ...operationalFor(prepared, {
        behaviorOutcome: 'PASS',
        finalOutcome: 'PASS',
      }),
    });
    expect(assembled.ok, issueCodes(assembled).join(', ')).toBe(true);
    if (!assembled.ok) return;
    expect(assembled.record.requiredChecks.map((check) => check.checkId)).toEqual([checkId]);
    expect(assembled.record.requiredChecks.every((check) => check.status === 'PASS')).toBe(true);
    expect(assembled.record.behaviorOutcome).toBe('PASS');
    expect(assembled.record.finalOutcome).toBe('PASS');
  });
});

// ── Public v4 command records ────────────────────────────────────────────────

function doctorOutcome() {
  return executeDoctorCommandContext({
    commandAuthority: DOCTOR_COMMAND_STATUS_AUTHORITY,
    checks: DOCTOR_COMMAND_CHECKS.map((declaration) => ({
      checkId: declaration.checkId,
      authorityState: 'current' as const,
      matched: true,
      actual: { observed: declaration.checkId },
    })),
    evidence: DOCTOR_COMMAND_REQUIRED_EVIDENCE.map((evidenceId) => ({
      evidenceId,
      availability: 'authoritative' as const,
    })),
    cleanupSucceeded: true,
  });
}

function productionOutcome() {
  return executeProductionAbsenceCommandContext({
    commandAuthority: PRODUCTION_ABSENCE_COMMAND_STATUS_AUTHORITY,
    checks: PRODUCTION_ABSENCE_COMMAND_CHECKS.map((declaration) => ({
      checkId: declaration.checkId,
      authorityState: 'current' as const,
      matched: true,
      actual: { observed: declaration.checkId },
    })),
    evidence: PRODUCTION_ABSENCE_COMMAND_REQUIRED_EVIDENCE.map((evidenceId) => ({
      evidenceId,
      availability: 'authoritative' as const,
    })),
    cleanupSucceeded: true,
  });
}

describe('[P7-B2-E1] public v4 command-context records', () => {
  it('maps both real command outcomes into separate closed public v4 command records', () => {
    const runId = 'b2e1-command-run';
    for (const [outcome, expectedCheckIds] of [
      [doctorOutcome(), DOCTOR_COMMAND_CHECKS.map((check) => check.checkId)],
      [productionOutcome(), PRODUCTION_ABSENCE_COMMAND_CHECKS.map((check) => check.checkId)],
    ] as const) {
      expect(outcome.issues).toEqual([]);
      expect(outcome.record).not.toBeNull();
      const record = outcome.record;
      if (record === null) continue;
      const assembled = assembleFinalPublicCommandRecordV4({
        command: record,
        runId,
        behaviorOutcome: outcome.behaviorOutcome,
        finalOutcome: outcome.finalOutcome,
        launch: buildPublicLaunchFacts({
          attempted: true,
          pid: 4242,
          processGroupId: 4242,
          readinessMs: 900,
          serverLogPath: '/b2e1-fixture-scratch/b2e1-owned-run/server.log',
        }),
        ownership: buildEstablishedOwnership(
          { ...OWNERSHIP_FIXTURE, runId },
          'stopped',
          `.next/verify-runs/${runId}`,
          '.pi/skills/verify-artwork-editor',
        ),
        cleanup: buildCleanupProjection({ ...CLEANUP_FIXTURE, runId }),
        diagnostics: [],
        runError: null,
        recordedAt: '2026-09-20T00:00:00.000Z',
      });
      expect(assembled.ok, issueCodes(assembled).join(', ')).toBe(true);
      if (!assembled.ok) continue;
      const publicRecord = assembled.record;
      expect(validateFinalPublicCommandRecordV4(publicRecord).ok).toBe(true);
      expect(publicRecord.checks.map((check) => check.checkId)).toEqual([...expectedCheckIds]);
      expect(publicRecord.checks.every((check) => check.status === 'PASS')).toBe(true);
      expect(publicRecord.behaviorOutcome).toBe('PASS');
      expect(publicRecord.finalOutcome).toBe('PASS');
      const read = readFinalPublicRecord(deepClone(publicRecord));
      expect(read.kind).toBe('command-v4');
      if (read.kind !== 'command-v4') continue;
      expect(read.record.command).toBe(publicRecord.command);
      expect(read.record.commandAuthority.commandAuthorityFingerprint).toBe(
        publicRecord.commandAuthority.commandAuthorityFingerprint,
      );
      for (const key of [
        'resolvedProfileFingerprint',
        'componentFingerprints',
        'actionCycles',
        'requiredChecks',
        'nestedProjections',
        'passed',
        'harnessInvalid',
      ]) {
        expect(Object.hasOwn(publicRecord, key), key).toBe(false);
      }
      walkKeys(publicRecord, (key, at) => {
        expect(key, at).not.toBe('passed');
        expect(key, at).not.toBe('harnessInvalid');
      });
    }
  });

  it('rejects a record that mixes a command authority with a compiled-profile identity', () => {
    const outcome = doctorOutcome();
    if (outcome.record === null) throw new Error('expected a command record');
    const assembled = assembleFinalPublicCommandRecordV4({
      command: outcome.record,
      runId: 'b2e1-command-run',
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
        runId: 'b2e1-command-run',
        allocationFailureCode: 'PORT_UNAVAILABLE',
        requestedPort: null,
      }),
      cleanup: null,
      diagnostics: [],
      runError: null,
      recordedAt: '2026-09-20T00:00:00.000Z',
    });
    if (!assembled.ok) throw new Error('expected the command record to assemble');
    const mixed = deepClone(assembled.record) as unknown as Record<string, unknown>;
    mixed.resolvedProfileFingerprint = 'a'.repeat(64);
    const validation = validateFinalPublicRecordV4(mixed);
    expect(validation.ok).toBe(false);
    expect(issueCodes(validation)).toContain('FINAL_RECORD_CHECK_CONTEXT_INVALID');
    expect(readFinalPublicRecord(mixed).kind).toBe('invalid');
  });
});

// ── Legacy, mixed, unknown and malformed discrimination ──────────────────────

describe('[P7-B2-E1] legacy, mixed, unknown and malformed records', () => {
  function legacyRecord(version: number, passed: boolean): Record<string, unknown> {
    return {
      schemaVersion: version,
      command: 'diagnostic',
      recordedAt: '2026-01-01T00:00:00.000Z',
      runId: `legacy-run-${version}`,
      caseId: 'legacy-case',
      materializationFingerprint: 'legacy-materialization',
      planFingerprint: 'legacy-plan',
      profile: 'legacy-profile',
      repositories: {},
      requiredChecks: [
        { checkId: 'geometry.delta', passed, evidenceIds: ['e1'] },
        { checkId: 'geometry.renderer', passed: false, evidenceIds: ['e2'] },
      ],
    };
  }

  it('reads v1/v2/v3 read-only, non-converting, with the historical false preserved', () => {
    for (const [version, label] of [
      [1, 'legacy-v1'],
      [2, 'legacy-v2'],
      [3, 'legacy-v3'],
    ] as const) {
      const legacy = legacyRecord(version, false);
      const read = readFinalPublicRecord(legacy);
      expect(read.kind, label).toBe(label);
      expect(read.legacy).toBe(true);
      expect(read.current).toBe(false);
      expect(read.ambiguous).toBe(true);
      expect(read.record).toEqual(legacy);
      if (!read.legacy) continue;
      expect(read.checks[0]?.kind).toBe('legacy-boolean');
      expect(read.checks[0]?.passed).toBe(false);
      expect(read.checks[0]?.status).toBeNull();
      expect(read.checks[0]?.ambiguous).toBe(true);
      expect(read.issues.map((entry) => entry.code)).toContain('RESULT_LEGACY_BOOLEAN_AMBIGUOUS');
      // The historical boolean is never converted into current credit.
      expect(read.issues.every((entry) => entry.code !== 'RESULT_BOOLEAN_PASSED_PRESENT')).toBe(
        true,
      );
    }
  });

  it('reads a historical true exactly as recorded without granting current status', () => {
    const read = readFinalPublicRecord(legacyRecord(3, true));
    expect(read.kind).toBe('legacy-v3');
    expect(read.legacy).toBe(true);
    expect(read.current).toBe(false);
    expect(read.ambiguous).toBe(true);
    if (!read.legacy) return;
    expect(read.checks[0]?.passed).toBe(true);
    expect(read.checks[0]?.status).toBeNull();
  });

  it('rejects a mixed boolean/status record, an unknown schema and a non-object', () => {
    const mixed = readFinalPublicRecord({
      schemaVersion: 3,
      requiredChecks: [{ checkId: 'geometry.delta', passed: true, status: 'PASS' }],
    });
    expect(mixed.kind).toBe('mixed');
    expect(mixed.record).toBeNull();

    const unknown = readFinalPublicRecord({ schemaVersion: 99, requiredChecks: [] });
    expect(unknown.kind).toBe('unknown');
    expect(unknown.record).toBeNull();

    const notObject = readFinalPublicRecord(42);
    expect(notObject.kind).toBe('invalid');
    expect(notObject.record).toBeNull();
  });

  it('fails closed on a malformed or incomplete v4 public record', () => {
    const prepared = preparedCases[0] as PreparedCase;
    const record = publicRecordFor(prepared);

    for (const [label, broken] of [
      ['missing operational region', { schemaVersion: 4, command: 'diagnostic' }],
      ['unknown top-level field', { ...deepClone(record), surprise: true }],
      [
        'missing resolved-profile fingerprint',
        { ...deepClone(record), resolvedProfileFingerprint: 'not-a-fingerprint' },
      ],
      ['missing required checks', { ...deepClone(record), requiredChecks: [] }],
      ['unknown nested field', mutateRecord(record, 'ownership.surprise', true)],
      ['malformed nested projection', mutateRecord(record, 'nestedProjections.0.family', 'ghost')],
      ['non-finite timing', mutateRecord(record, 'readiness.timings.setup', 'twelve')],
      ['malformed targets', mutateRecord(record, 'targets.0.elementId', 7)],
    ] as const) {
      const read = readFinalPublicRecord(broken);
      expect(read.kind, label).toBe('invalid');
      expect(read.record, label).toBeNull();
      expect(validateFinalPublicRunRecordV4(broken).ok, label).toBe(false);
    }

    const validation = validateFinalPublicRunRecordV4({
      ...deepClone(record),
      surprise: true,
    });
    expect(issueCodes(validation)).toContain('FINAL_RECORD_FIELD_INVALID');
  });

  it('fails closed on a durable record file that is not valid JSON', () => {
    const root = tempEvidenceRoot();
    const target = path.join(root, 'run-record.json');
    writeFileSync(target, '{not json', 'utf8');
    const read = readFinalPublicRecordFile(target);
    expect(read.kind).toBe('invalid');
    expect(read.record).toBeNull();
  });
});

// ── Recursive rejection of the removed legacy authorities ────────────────────

describe('[P7-B2-E1] recursive rejection of passed and harnessInvalid anywhere', () => {
  const prepared = preparedCases[2] as PreparedCase; // image: check-bearing nested projections
  const record = publicRecordFor(prepared);

  /**
   * Every position a legacy authority could hide: top level, the child region,
   * every check-bearing nested projection, and every safe operational
   * projection, including positions no shape validator inspects.
   */
  const LEGACY_PATHS = [
    'passed',
    'requiredChecks.0.passed',
    'requiredChecks.0.actual.passed',
    'requiredChecks.0.expected.passed',
    'actionCycles.0.passed',
    'nestedProjections.0.passed',
    'nestedProjections.0.actionCycles.0.passed',
    'nestedProjections.1.passed',
    'nestedProjections.1.cycles.0.passed',
    'nestedProjections.1.cycles.0.checks.0.passed',
    'nestedProjections.1.cycles.0.checks.0.actual.passed',
    'ownership.passed',
    'ownership.resources.repository.passed',
    'cleanup.facts.passed',
    'launch.passed',
    'readiness.passed',
    'readiness.timings.passed',
    'diagnostics.0.passed',
    'diagnostics.0.context.passed',
    'targets.0.passed',
    'repository.passed',
    'fingerprints.passed',
    'adapter.passed',
    'workflow.passed',
    'fixture.passed',
    'ownership.resources.passed',
  ] as const;

  it('rejects a legacy boolean passed injected at any depth with the exact issue code', () => {
    for (const dotted of LEGACY_PATHS) {
      const mutated = mutateRecord(record, dotted, true);
      const validation = validateFinalPublicRunRecordV4(mutated);
      expect(validation.ok, dotted).toBe(false);
      expect(issueCodes(validation), dotted).toContain('FINAL_RECORD_LEGACY_BOOLEAN_PRESENT');
      const read = readFinalPublicRecord(mutated);
      expect(read.kind, dotted).not.toBe('current-v4');
      expect(read.record, dotted).toBeNull();
    }
    const unmutated = validateFinalPublicRunRecordV4(record);
    expect(unmutated.ok).toBe(true);
  });

  it('rejects the harnessInvalid side channel injected at any depth with the exact issue code', () => {
    for (const dotted of LEGACY_PATHS) {
      const path = dotted.replace(/passed$/, 'harnessInvalid');
      const mutated = mutateRecord(record, path, false);
      const validation = validateFinalPublicRunRecordV4(mutated);
      expect(validation.ok, path).toBe(false);
      expect(issueCodes(validation), path).toContain('FINAL_RECORD_HARNESS_INVALID_PRESENT');
      const read = readFinalPublicRecord(mutated);
      expect(read.kind, path).not.toBe('current-v4');
    }
  });

  it('refuses to write a child carrying either legacy authority and leaves no file', () => {
    const child = childRecordFor(prepared);
    for (const [dotted, expectedCode] of [
      ['requiredChecks.0.passed', 'RESULT_BOOLEAN_PASSED_PRESENT'],
      ['requiredChecks.0.harnessInvalid', 'RESULT_HARNESS_INVALID_PRESENT'],
      ['nestedProjections.1.cycles.0.checks.0.passed', 'RESULT_BOOLEAN_PASSED_PRESENT'],
      ['actionCycles.0.harnessInvalid', 'FINAL_RECORD_HARNESS_INVALID_PRESENT'],
    ] as const) {
      const mutated = mutateRecord(child, dotted, true);
      const root = tempEvidenceRoot();
      const target = path.join(root, 'run-record.json');
      let thrown: unknown = null;
      try {
        writeFinalPublicRunRecordV4({
          child: mutated,
          ...operationalFor(prepared),
          evidenceRoot: root,
        });
      } catch (error) {
        thrown = error;
      }
      expect(thrown, dotted).toBeInstanceOf(RunRecordWriteError);
      // The refusal names the exact strict-v4 agreement code, never a wrapper.
      expect(String((thrown as Error).message), dotted).toContain(expectedCode);
      expect(existsSync(target), dotted).toBe(false);
      expect(readdirSync(root), dotted).toEqual([]);
    }
  });
});

// ── Complete cycle-safe traversal: depth, arrays, cycles and non-plain holders ─

describe('[P7-B2-E1] complete cycle-safe legacy-authority traversal', () => {
  function codesFor(value: unknown): string[] {
    return finalRecordLegacyAuthorityIssues(value, 'traversal fixture').map((entry) => entry.code);
  }

  it('detects either authority at depth 16, 20 and far below the removed cutoff', () => {
    for (const deep of [16, 17, 20, 64, 512, 4096]) {
      expect(codesFor(nestedChain(deep, { passed: true })), `passed at ${deep}`).toContain(
        'FINAL_RECORD_LEGACY_BOOLEAN_PRESENT',
      );
      expect(
        codesFor(nestedChain(deep, { harnessInvalid: false })),
        `harnessInvalid at ${deep}`,
      ).toContain('FINAL_RECORD_HARNESS_INVALID_PRESENT');
      // Same depth with no authority is not a false positive, so the hit above
      // is real detection rather than a fallback rejection.
      expect(codesFor(nestedChain(deep, { fine: true })), `clean at ${deep}`).toEqual([]);
    }
  });

  it('detects a legacy authority nested through arrays and mixed containers', () => {
    let nested: unknown = { passed: true };
    for (let level = 0; level < 64; level += 1) nested = [nested];
    expect(codesFor(nested)).toContain('FINAL_RECORD_LEGACY_BOOLEAN_PRESENT');

    const mixed = [{ a: [{ b: [[{ harnessInvalid: true }]] }] }];
    expect(codesFor(mixed)).toContain('FINAL_RECORD_HARNESS_INVALID_PRESENT');
  });

  it('rejects a deep legacy authority through the public validators, not only the detector', () => {
    const prepared = preparedCases[0] as PreparedCase;
    const record = publicRecordFor(prepared);
    for (const deep of [20, 256]) {
      const withPassed = mutateRecord(
        record,
        'diagnostics.0.context.deep',
        nestedChain(deep, { passed: true }),
      );
      const validation = validateFinalPublicRunRecordV4(withPassed);
      expect(validation.ok, `depth ${deep}`).toBe(false);
      expect(issueCodes(validation), `depth ${deep}`).toContain(
        'FINAL_RECORD_LEGACY_BOOLEAN_PRESENT',
      );
      expect(readFinalPublicRecord(withPassed).kind, `depth ${deep}`).not.toBe('current-v4');

      const withHarness = mutateRecord(
        record,
        'diagnostics.0.context.deep',
        nestedChain(deep, { harnessInvalid: true }),
      );
      expect(issueCodes(validateFinalPublicRunRecordV4(withHarness)), `depth ${deep}`).toContain(
        'FINAL_RECORD_HARNESS_INVALID_PRESENT',
      );
    }
    // The unmutated record still validates, so nesting depth is the only cause.
    expect(validateFinalPublicRunRecordV4(record).ok).toBe(true);
  });

  it('terminates on a cyclic sub-graph and still detects authority behind the cycle', () => {
    const cyclic: Record<string, unknown> = { inner: {} };
    (cyclic.inner as Record<string, unknown>).loop = cyclic;
    expect(codesFor(cyclic)).toEqual([]);

    const withAuthority: Record<string, unknown> = { inner: {} };
    (withAuthority.inner as Record<string, unknown>).loop = withAuthority;
    (withAuthority.inner as Record<string, unknown>).harnessInvalid = true;
    expect(codesFor(withAuthority)).toContain('FINAL_RECORD_HARNESS_INVALID_PRESENT');
  });

  it('terminates on a cyclic public record and rejects authority found across the cycle', () => {
    const prepared = preparedCases[0] as PreparedCase;
    const record = publicRecordFor(prepared);

    const cleanCycle: Record<string, unknown> = { inner: {} };
    (cleanCycle.inner as Record<string, unknown>).loop = cleanCycle;
    const cleanRecord = mutateRecord(record, 'diagnostics.0.context.cyclic', cleanCycle);
    expect(issueCodes(validateFinalPublicRunRecordV4(cleanRecord))).not.toContain(
      'FINAL_RECORD_LEGACY_BOOLEAN_PRESENT',
    );

    const authorityCycle: Record<string, unknown> = { inner: {} };
    (authorityCycle.inner as Record<string, unknown>).loop = authorityCycle;
    (authorityCycle.inner as Record<string, unknown>).passed = true;
    const mutated = mutateRecord(record, 'diagnostics.0.context.cyclic', authorityCycle);
    const validation = validateFinalPublicRunRecordV4(mutated);
    expect(validation.ok).toBe(false);
    expect(issueCodes(validation)).toContain('FINAL_RECORD_LEGACY_BOOLEAN_PRESENT');
  });

  it('detects authority on a non-plain holder directly, behind a chain and inside an array', () => {
    class LegacyHolder {
      own = true;
    }
    const holder = new LegacyHolder() as LegacyHolder & { passed?: boolean };
    holder.passed = true;
    const map = new Map<string, number>([['entry', 1]]) as Map<string, number> & {
      harnessInvalid?: boolean;
    };
    map.harnessInvalid = true;

    expect(codesFor(holder)).toContain('FINAL_RECORD_LEGACY_BOOLEAN_PRESENT');
    expect(codesFor([nestedChain(30, holder)])).toContain('FINAL_RECORD_LEGACY_BOOLEAN_PRESENT');
    expect(codesFor({ deep: nestedChain(30, { map }) })).toContain(
      'FINAL_RECORD_HARNESS_INVALID_PRESENT',
    );
  });

  it('makes assembly fail closed when a record carries a non-plain value', () => {
    const prepared = preparedCases[0] as PreparedCase;
    const map = new Map<string, number>([['entry', 1]]);
    const child = mutateRecord(childRecordFor(prepared), 'requiredChecks.0.actual.nested', map);
    const assembled = assembleFinalPublicRunRecordV4({
      child,
      ...operationalFor(prepared),
    });
    expect(assembled.ok).toBe(false);
    if (assembled.ok) return;
    expect(issueCodes(assembled)).toContain('FINAL_RECORD_FIELD_INVALID');
  });
});

// ── Redaction boundary and exact serialized bytes ────────────────────────────

describe('[P7-B2-E1] public redaction and exact-byte guard', () => {
  const prepared = preparedCases[4] as PreparedCase; // crossword family
  const child = childRecordFor(prepared);
  const operational = operationalFor(prepared);

  function attempt(overrides: {
    readonly child?: FinalCurrentChildRecordV4;
    readonly operational?: Partial<Omit<AssembleFinalPublicRunRecordV4Input, 'child'>>;
    readonly forbiddenPaths?: readonly string[];
  }): { readonly root: string; readonly target: string; readonly thrown: unknown } {
    const root = tempEvidenceRoot();
    let thrown: unknown = null;
    try {
      writeFinalPublicRunRecordV4({
        child: overrides.child ?? child,
        ...operational,
        ...(overrides.operational ?? {}),
        evidenceRoot: root,
        forbiddenPaths: overrides.forbiddenPaths ?? [],
      });
    } catch (error) {
      thrown = error;
    }
    return { root, target: path.join(root, 'run-record.json'), thrown };
  }

  it('fails before writing on private paths, file:, blob:, encoded traversal and a raw handle', () => {
    const cases = [
      [
        'private absolute path',
        mutateRecord(child, 'requiredChecks.0.actual.leaked', '/Users/private-owner/secret/root'),
      ],
      [
        'file: form',
        mutateRecord(
          child,
          'nestedProjections.1.executions.0.checks.0.actual.leaked',
          'file:///etc/passwd',
        ),
      ],
      [
        'blob transient handle',
        mutateRecord(
          child,
          'nestedProjections.1.executions.0.checks.0.expected.leaked',
          'blob:https://127.0.0.1/9d1f',
        ),
      ],
      [
        'encoded traversal',
        mutateRecord(child, 'requiredChecks.0.expected.leaked', '%2e%2e%2fUsers%2fprivate-owner'),
      ],
      [
        'raw transient handle',
        mutateRecord(child, 'nestedProjections.0.actionCycles.0.leak', 'blob:worker-handle-1'),
      ],
    ] as const;
    for (const [name, mutated] of cases) {
      const { thrown, target, root } = attempt({ child: mutated });
      expect(thrown, name).not.toBeNull();
      expect(isRedactionRejected(thrown), name).toBe(true);
      expect(existsSync(target), name).toBe(false);
      expect(readdirSync(root), name).toEqual([]);
    }
  });

  it('fails before writing on an unsafe key', () => {
    const { thrown, target, root } = attempt({
      operational: {
        readiness: {
          ...operational.readiness,
          timings: { setup: 1, 'blob:https://127.0.0.1/1': 2 },
        },
      },
    });
    expect(thrown).not.toBeNull();
    expect(isRedactionRejected(thrown)).toBe(true);
    expect(existsSync(target)).toBe(false);
    expect(readdirSync(root)).toEqual([]);
  });

  it('rejects a registered private root only when it is registered', () => {
    const accepted = attempt({
      operational: { runError: '/b2e1-forbidden-root/secret.txt' },
    });
    expect(accepted.thrown).toBeNull();

    const rejected = attempt({
      operational: { runError: '/b2e1-forbidden-root/secret.txt' },
      forbiddenPaths: ['/b2e1-forbidden-root'],
    });
    expect(rejected.thrown).not.toBeNull();
    expect(isRedactionRejected(rejected.thrown)).toBe(true);
    expect(existsSync(rejected.target)).toBe(false);
  });

  it('rejects an unsafe candidate whose only prohibited content is deep inside a projection', () => {
    const mutated = mutateRecord(
      child,
      'nestedProjections.1.executions.2.checks.0.actual.deep',
      'blob:deep-transient-handle',
    );
    const { thrown, target } = attempt({ child: mutated });
    expect(thrown).not.toBeNull();
    expect(isRedactionRejected(thrown)).toBe(true);
    expect(existsSync(target)).toBe(false);
  });

  it('guards the complete record and the exact serialized bytes that reach disk', () => {
    const root = tempEvidenceRoot();
    const written = writeFinalPublicRunRecordV4({
      child: childRecordFor(prepared),
      ...operationalFor(prepared),
      evidenceRoot: root,
    });
    const onDisk = readFileSync(written.path, 'utf8');
    expect(onDisk).toBe(`${written.serialized}\n`);
    // The guard ran over the complete accepted record, and re-serializing it
    // reproduces exactly the guarded bytes that were written.
    expect(serializePublicRecord(written.record)).toBe(written.serialized);
    expect(`${serializePublicRecord(written.record)}\n`).toBe(onDisk);
    expect(JSON.parse(onDisk) as unknown).toEqual(written.record);
    expect(Object.isFrozen(written.record)).toBe(true);
    walkKeys(written.record, (key, at) => {
      expect(key, at).not.toBe('passed');
      expect(key, at).not.toBe('harnessInvalid');
    });
  });
});

// ── Exclusive write, overwrite refusal, strict self-readback ─────────────────

describe('[P7-B2-E1] exclusive durable write and strict self-readback', () => {
  const prepared = preparedCases[0] as PreparedCase;

  it('prepares current-v4 without I/O and preserves the exact direct-writer bytes', () => {
    const parent = tempEvidenceRoot();
    const root = path.join(parent, 'not-created-by-prepare');
    const input = {
      child: childRecordFor(prepared),
      ...operationalFor(prepared),
      evidenceRoot: root,
    };

    const noIo = prepareFinalPublicRunRecordV4(input);
    expect(existsSync(root)).toBe(false);
    expect(serializePreparedFinalPublicRunRecordV4(noIo)).toBe(noIo.serialized);

    mkdirSync(root);
    const written = writeFinalPublicRunRecordV4(input);
    expect(written.record).toEqual(noIo.record);
    expect(written.serialized).toBe(noIo.serialized);
    expect(readFileSync(written.path, 'utf8')).toBe(`${noIo.serialized}\n`);
  });

  it('writes exactly one record exclusively and refuses to overwrite it', () => {
    const root = tempEvidenceRoot();
    const target = path.join(root, 'run-record.json');
    expect(existsSync(target)).toBe(false);
    const written = writeFinalPublicRunRecordV4({
      child: childRecordFor(prepared),
      ...operationalFor(prepared),
      evidenceRoot: root,
    });
    expect(written.path).toBe(target);
    expect(readdirSync(root)).toEqual(['run-record.json']);
    const bytesAfterFirstWrite = readFileSync(target);

    let thrown: unknown = null;
    try {
      writeFinalPublicRunRecordV4({
        child: childRecordFor(prepared),
        ...operationalFor(prepared, { recordedAt: '2026-09-21T00:00:00.000Z' }),
        evidenceRoot: root,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(RunRecordExistsError);
    expect(readFileSync(target)).toEqual(bytesAfterFirstWrite);
    expect(readdirSync(root)).toEqual(['run-record.json']);
  });

  it('proves the current v4 readback through the durable file reader', () => {
    const root = tempEvidenceRoot();
    const written = writeFinalPublicRunRecordV4({
      child: childRecordFor(prepared),
      ...operationalFor(prepared),
      evidenceRoot: root,
    });
    const read = readFinalPublicRecordFile(written.path);
    expect(read.kind).toBe('current-v4');
    if (read.kind !== 'current-v4') return;
    expect(read.record).toEqual(written.record);
    expect(read.current).toBe(true);
    expect(read.legacy).toBe(false);
    expect(read.ambiguous).toBe(false);
  });

  it('fails self-readback when the durable bytes are not byte-identical to the guarded bytes', () => {
    const root = tempEvidenceRoot();
    const target = path.join(root, 'run-record.json');
    writeFileSync(target, '{"schemaVersion":4}\n', 'utf8');
    expect(() =>
      readBackFinalPublicRunRecordV4(target, '{"schemaVersion":4,"tampered":true}'),
    ).toThrow(RunRecordWriteError);
    // Byte-equal but not a complete closed record: the strict validation branch.
    expect(() => readBackFinalPublicRunRecordV4(target, '{"schemaVersion":4}')).toThrow(
      RunRecordWriteError,
    );
  });

  it('fails self-readback when the durable bytes are not byte-canonical', () => {
    const root = tempEvidenceRoot();
    const written = writeFinalPublicRunRecordV4({
      child: childRecordFor(prepared),
      ...operationalFor(prepared),
      evidenceRoot: root,
    });
    const pretty = JSON.stringify(JSON.parse(written.serialized) as unknown, null, 2);
    const target = path.join(root, 'pretty.json');
    writeFileSync(target, `${pretty}\n`, 'utf8');
    expect(() => readBackFinalPublicRunRecordV4(target, pretty)).toThrow(RunRecordWriteError);
  });

  it('writes only inside the caller-supplied temporary root', () => {
    const root = tempEvidenceRoot();
    writeFinalPublicRunRecordV4({
      child: childRecordFor(prepared),
      ...operationalFor(prepared),
      evidenceRoot: root,
    });
    expect(root.startsWith(os.tmpdir())).toBe(true);
    for (const created of createdRoots) {
      expect(created.startsWith(os.tmpdir())).toBe(true);
    }
    expect(readdirSync(root)).toEqual(['run-record.json']);
  });
});

// ── Exclusive durable command write and strict command self-readback ─────────

describe('[P7-B2-E1] exclusive durable command write and strict command self-readback', () => {
  const COMMAND_RUN_ID = 'b2e1-durable-command-run';

  function commandPortInput(
    outcome: ReturnType<typeof doctorOutcome>,
  ): Omit<WriteFinalPublicCommandRecordV4Input, 'evidenceRoot'> {
    const record = outcome.record;
    if (record === null) throw new Error('expected a command record');
    return {
      command: record,
      runId: COMMAND_RUN_ID,
      behaviorOutcome: outcome.behaviorOutcome,
      finalOutcome: outcome.finalOutcome,
      launch: buildPublicLaunchFacts({
        attempted: true,
        pid: 4242,
        processGroupId: 4242,
        readinessMs: 900,
        serverLogPath: '/b2e1-fixture-scratch/b2e1-owned-run/server.log',
      }),
      ownership: buildEstablishedOwnership(
        { ...OWNERSHIP_FIXTURE, runId: COMMAND_RUN_ID },
        'stopped',
        `.next/verify-runs/${COMMAND_RUN_ID}`,
        '.pi/skills/verify-artwork-editor',
      ),
      cleanup: buildCleanupProjection({ ...CLEANUP_FIXTURE, runId: COMMAND_RUN_ID }),
      diagnostics: [],
      runError: null,
      recordedAt: '2026-09-20T00:00:00.000Z',
    };
  }

  it('prepares command-v4 without I/O and preserves the exact direct-writer bytes', () => {
    const parent = tempEvidenceRoot();
    const root = path.join(parent, 'not-created-by-prepare');
    const input = {
      ...commandPortInput(doctorOutcome()),
      evidenceRoot: root,
    };

    const noIo = prepareFinalPublicCommandRecordV4(input);
    expect(existsSync(root)).toBe(false);
    expect(serializePreparedFinalPublicCommandRecordV4(noIo)).toBe(noIo.serialized);

    mkdirSync(root);
    const written = writeFinalPublicCommandRecordV4(input);
    expect(written.record).toEqual(noIo.record);
    expect(written.serialized).toBe(noIo.serialized);
    expect(readFileSync(written.path, 'utf8')).toBe(`${noIo.serialized}\n`);
  });

  it('writes and strictly reads back Doctor and production-absence command records', () => {
    for (const [label, outcome] of [
      ['Doctor', doctorOutcome()],
      ['production-absence', productionOutcome()],
    ] as const) {
      const root = tempEvidenceRoot();
      const written = writeFinalPublicCommandRecordV4({
        ...commandPortInput(outcome),
        evidenceRoot: root,
      });
      expect(written.path, label).toBe(path.join(root, 'run-record.json'));
      expect(readdirSync(root), label).toEqual(['run-record.json']);
      const onDisk = readFileSync(written.path, 'utf8');
      expect(onDisk, label).toBe(`${written.serialized}\n`);
      expect(serializePublicRecord(written.record), label).toBe(written.serialized);
      expect(Object.isFrozen(written.record), label).toBe(true);
      // The strict command self-readback validates the command family DTO.
      const readBack = readBackFinalPublicCommandRecordV4(written.path, written.serialized);
      expect(readBack.command, label).toBe(written.record.command);
      expect(readBack.commandAuthority.commandAuthorityFingerprint, label).toBe(
        written.record.commandAuthority.commandAuthorityFingerprint,
      );
      const read = readFinalPublicRecordFile(written.path);
      expect(read.kind, label).toBe('command-v4');
      if (read.kind !== 'command-v4') continue;
      expect(read.record, label).toEqual(written.record);
      for (const key of [
        'resolvedProfileFingerprint',
        'componentFingerprints',
        'actionCycles',
        'requiredChecks',
        'nestedProjections',
        'passed',
        'harnessInvalid',
      ]) {
        expect(Object.hasOwn(written.record, key), `${label}:${key}`).toBe(false);
      }
      walkKeys(written.record, (key, at) => {
        expect(key, at).not.toBe('passed');
        expect(key, at).not.toBe('harnessInvalid');
      });
    }
  });

  it('refuses to overwrite an existing durable command record', () => {
    const root = tempEvidenceRoot();
    const target = path.join(root, 'run-record.json');
    const input = commandPortInput(doctorOutcome());
    writeFinalPublicCommandRecordV4({ ...input, evidenceRoot: root });
    const bytesAfterFirstWrite = readFileSync(target);

    let thrown: unknown = null;
    try {
      writeFinalPublicCommandRecordV4({
        ...input,
        recordedAt: '2026-09-21T00:00:00.000Z',
        evidenceRoot: root,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(RunRecordExistsError);
    expect(readFileSync(target)).toEqual(bytesAfterFirstWrite);
    expect(readdirSync(root)).toEqual(['run-record.json']);
  });

  it('fails strict command self-readback on tampered, non-JSON, incomplete and non-canonical bytes', () => {
    const root = tempEvidenceRoot();
    const target = path.join(root, 'run-record.json');
    writeFileSync(target, '{"schemaVersion":4}\n', 'utf8');
    // Byte-difference branch.
    expect(() =>
      readBackFinalPublicCommandRecordV4(target, '{"schemaVersion":4,"tampered":true}'),
    ).toThrow(RunRecordWriteError);
    // Byte-equal but not a complete closed command record.
    expect(() => readBackFinalPublicCommandRecordV4(target, '{"schemaVersion":4}')).toThrow(
      RunRecordWriteError,
    );

    // Invalid JSON branch (bytes still match exactly).
    const badJson = path.join(root, 'bad-json.json');
    writeFileSync(badJson, '{not json\n', 'utf8');
    expect(() => readBackFinalPublicCommandRecordV4(badJson, '{not json')).toThrow(
      RunRecordWriteError,
    );

    // Non-canonical branch: byte-equal and valid, but not the guarded serialization.
    const written = writeFinalPublicCommandRecordV4({
      ...commandPortInput(productionOutcome()),
      evidenceRoot: tempEvidenceRoot(),
    });
    const pretty = JSON.stringify(JSON.parse(written.serialized) as unknown, null, 2);
    const prettyTarget = path.join(root, 'pretty.json');
    writeFileSync(prettyTarget, `${pretty}\n`, 'utf8');
    expect(() => readBackFinalPublicCommandRecordV4(prettyTarget, pretty)).toThrow(
      RunRecordWriteError,
    );
  });

  it('keeps the two record families strictly non-interchangeable on readback', () => {
    const prepared = preparedCases[0] as PreparedCase;
    const commandRoot = tempEvidenceRoot();
    const commandRecord = writeFinalPublicCommandRecordV4({
      ...commandPortInput(doctorOutcome()),
      evidenceRoot: commandRoot,
    });
    const runRoot = tempEvidenceRoot();
    const runRecord = writeFinalPublicRunRecordV4({
      child: childRecordFor(prepared),
      ...operationalFor(prepared),
      evidenceRoot: runRoot,
    });

    // A genuine command record is not a valid child-record readback.
    expect(() =>
      readBackFinalPublicRunRecordV4(commandRecord.path, commandRecord.serialized),
    ).toThrow(RunRecordWriteError);
    // A genuine child record is not a valid command-record readback.
    expect(() => readBackFinalPublicCommandRecordV4(runRecord.path, runRecord.serialized)).toThrow(
      RunRecordWriteError,
    );
    // Each family reads back only through its own reader.
    expect(readFinalPublicRecordFile(commandRecord.path).kind).toBe('command-v4');
    expect(readFinalPublicRecordFile(runRecord.path).kind).toBe('current-v4');
  });

  it('guards the complete command record and exact bytes before any write', () => {
    const root = tempEvidenceRoot();
    const target = path.join(root, 'run-record.json');
    let thrown: unknown = null;
    try {
      writeFinalPublicCommandRecordV4({
        ...commandPortInput(doctorOutcome()),
        runError: '/b2e1-forbidden-root/secret.txt',
        forbiddenPaths: ['/b2e1-forbidden-root'],
        evidenceRoot: root,
      });
    } catch (error) {
      thrown = error;
    }
    expect(isRedactionRejected(thrown)).toBe(true);
    expect(existsSync(target)).toBe(false);
    expect(readdirSync(root)).toEqual([]);
  });

  it('refuses a command record carrying either legacy authority and writes nothing', () => {
    const outcome = doctorOutcome();
    const record = outcome.record;
    if (record === null) throw new Error('expected a command record');

    for (const [dotted, value, expectedCode] of [
      ['checks.0.passed', true, 'RESULT_BOOLEAN_PASSED_PRESENT'],
      ['checks.0.harnessInvalid', true, 'RESULT_HARNESS_INVALID_PRESENT'],
      [
        'checks.0.actual.deep',
        nestedChain(120, { harnessInvalid: true }),
        'FINAL_RECORD_HARNESS_INVALID_PRESENT',
      ],
    ] as const) {
      const mutated = mutateRecord(record, dotted, value);
      const root = tempEvidenceRoot();
      const target = path.join(root, 'run-record.json');
      let thrown: unknown = null;
      try {
        writeFinalPublicCommandRecordV4({
          ...commandPortInput(outcome),
          command: mutated,
          evidenceRoot: root,
        });
      } catch (error) {
        thrown = error;
      }
      expect(thrown, dotted).toBeInstanceOf(RunRecordWriteError);
      expect(String((thrown as Error).message), dotted).toContain(expectedCode);
      expect(existsSync(target), dotted).toBe(false);
      expect(readdirSync(root), dotted).toEqual([]);
    }
  });
});

// ── Mirrored vocabulary and closed key set ───────────────────────────────────

describe('[P7-B2-E1] closed vocabulary agreements', () => {
  it('mirrors the current public path vocabulary exactly', () => {
    expect([...FINAL_PUBLIC_PATH_ROLES]).toEqual([...PUBLIC_PATH_ROLES]);
    expect(FINAL_PUBLIC_PATH_REF_DOMAIN).toBe(PUBLIC_PATH_REF_DOMAIN);
  });

  it('declares a unique closed public record key set covering the child and operational regions', () => {
    expect(new Set(FINAL_PUBLIC_RUN_RECORD_KEYS).size).toBe(FINAL_PUBLIC_RUN_RECORD_KEYS.length);
    for (const key of [
      'schemaVersion',
      'command',
      'recordedAt',
      'runId',
      'caseId',
      'materializationFingerprint',
      'planFingerprint',
      'profile',
      'observationId',
      'resolvedProfileFingerprint',
      'componentFingerprints',
      'actionCycles',
      'requiredChecks',
      'nestedProjections',
      'repository',
      'fingerprints',
      'adapter',
      'workflow',
      'fixture',
      'targets',
      'readiness',
      'behaviorOutcome',
      'finalOutcome',
      'launch',
      'ownership',
      'cleanup',
      'diagnostics',
      'runError',
    ]) {
      expect(FINAL_PUBLIC_RUN_RECORD_KEYS, key).toContain(key);
    }
    const prepared = preparedCases[0] as PreparedCase;
    expect(Object.keys(publicRecordFor(prepared)).sort()).toEqual(
      [...FINAL_PUBLIC_RUN_RECORD_KEYS].sort(),
    );
  });
});

// ── Inactive boundary and frozen active baseline ─────────────────────────────

describe('[P7-B2-E1] current import boundary and retained legacy baseline', () => {
  const NEW_MODULES = [
    'src/contracts/final-public-record.ts',
    'src/evidence/final-writer.ts',
    'src/evidence/final-reader.ts',
  ];

  function source(relative: string): string {
    return readFileSync(path.join(skillRoot, relative), 'utf8');
  }

  it('is reached by the public barrel and the current façade, never by a legacy writer, reader, runtime, executor, browser, or Oracle module', () => {
    const moduleMarkers = ['final-public-record', 'final-writer', 'final-reader'];
    const markers = [
      'assembleFinalPublicRunRecordV4',
      'assembleFinalPublicCommandRecordV4',
      'validateFinalPublicRunRecordV4',
      'validateFinalPublicRecordV4',
      'readFinalPublicRecord',
      'writeFinalPublicRunRecordV4',
      'writeFinalPublicCommandRecordV4',
      'readBackFinalPublicCommandRecordV4',
      'FINAL_PUBLIC_RECORD_SCHEMA_VERSION',
    ];
    for (const relative of [
      'src/evidence/writer.ts',
      'src/evidence/reader.ts',
      'src/evidence/public-dto.ts',
      'src/evidence/suite-record.ts',
      'src/evidence/guard.ts',
      'src/runtime/execute-plan.ts',
      'src/runtime/outcomes.ts',
      'src/runtime/result-outcome.ts',
      'src/runtime/action-cycle.ts',
      'src/cli/diagnostic.ts',
      'src/cli/suite.ts',
      'src/cli/doctor.ts',
      'src/cli/production-absence.ts',
      'src/cli/main.ts',
      'src/browser/doctor.ts',
      'src/browser/production-absence.ts',
    ]) {
      const text = source(relative);
      for (const marker of moduleMarkers) {
        expect(text, `module ${relative} imports ${marker}`).not.toMatch(
          new RegExp(`from '[^']*${marker}'`),
        );
      }
      for (const marker of markers) {
        expect(text, `module ${relative} references ${marker}`).not.toContain(marker);
      }
    }
    // The public barrel exposes the current final public evidence surface.
    const barrel = source('src/index.ts');
    for (const marker of moduleMarkers) {
      expect(barrel, `barrel exposes ${marker}`).toContain(marker);
    }
  });

  it('reaches no active executor, Oracle, CLI, browser, writer or classifier module', () => {
    for (const relative of NEW_MODULES) {
      const text = source(relative);
      expect(text, relative).not.toMatch(/from '\.\.\/(cli|browser|oracles|commands|workflows)\//);
      expect(text, relative).not.toMatch(/from '\.\.\/runtime\/(outcomes|execute|action-cycle)/);
      expect(text, relative).not.toContain('writePublicRunRecord');
      expect(text, relative).not.toContain('writePublicSuiteRecord');
      expect(text, relative).not.toContain('contracts/execution');
    }
    // The public DTO contract module may only take types from the active public
    // projection module; never a runtime value edge.
    const dtoSource = source('src/contracts/final-public-record.ts');
    const flattened = dtoSource.replace(/\s+/g, ' ');
    expect(flattened).toContain('import type { PublicCleanupProjection');
    expect(flattened).toContain("from '../evidence/public-dto'");
    expect(flattened).not.toMatch(/import \{[^}]*\} from '\.\.\/evidence\/public-dto'/);
    // The durable evidence modules may import only the accepted guard/writer.
    for (const relative of ['src/evidence/final-writer.ts', 'src/evidence/final-reader.ts']) {
      for (const line of source(relative).split('\n')) {
        if (line.startsWith('import') && line.includes("from './")) {
          expect(
            [
              "from './guard'",
              "from './writer'",
              "from './final-writer'",
              "from './final-reader'",
            ].some((allowed) => line.includes(allowed)),
            `${relative}: ${line}`,
          ).toBe(true);
        }
      }
    }
  });

  it('owns no default or active evidence location', () => {
    for (const relative of NEW_MODULES) {
      const text = source(relative);
      expect(text, relative).not.toContain("evidence', 'runs'");
      expect(text, relative).not.toContain('/Users/');
      expect(text, relative).not.toContain('process.cwd()');
      expect(text, relative).not.toContain('process.env');
      expect(text, relative).not.toMatch(/evidenceRoot\s*=\s*'/);
    }
    expect(source('src/evidence/final-writer.ts')).toContain(
      'path.join(input.evidenceRoot, RUN_RECORD_FILE_NAME)',
    );
    expect(source('src/evidence/final-reader.ts')).toContain("readFileSync(target, 'utf8')");
  });

  it('writes no accepted run or suite evidence outside an isolated temporary root', () => {
    const runsRoot = path.join(skillRoot, 'evidence', 'runs');
    const before = existsSync(runsRoot) ? readdirSync(runsRoot).sort() : [];
    const prepared = preparedCases[1] as PreparedCase;
    const root = tempEvidenceRoot();
    writeFinalPublicRunRecordV4({
      child: childRecordFor(prepared),
      ...operationalFor(prepared),
      evidenceRoot: root,
    });
    const after = existsSync(runsRoot) ? readdirSync(runsRoot).sort() : [];
    expect(after).toEqual(before);
    expect(readdirSync(root)).toEqual(['run-record.json']);
    expect(existsSync(path.join(root, 'suite-record.json'))).toBe(false);
  });

  it('retains the historical baseline off the current path while the barrel exposes only the current final surface', () => {
    expect(source('src/contracts/execution.ts')).toMatch(
      /export interface CheckResult \{\n {2}checkId: string;\n {2}passed: boolean;\n\}/,
    );
    expect(source('src/contracts/schema-versions.ts')).toContain(
      'export const DIAGNOSTIC_RUN_RECORD_SCHEMA_VERSION = 3;',
    );
    expect(source('src/runtime/outcomes.ts')).toContain('harnessInvalid');
    // The historical reader keeps explicit, non-converting legacy labels only.
    const reader = source('src/evidence/reader.ts');
    expect(reader).toContain('export const LEGACY_V3_LABEL');
    expect(reader).not.toContain('CURRENT_V3_LABEL');
    // The former current v3 writer is gone.
    expect(source('src/evidence/writer.ts')).not.toMatch(
      /export (function|const) writePublicRunRecordV3/,
    );
    // The public barrel exposes the current final public surface and none of the
    // removed legacy public authorities.
    const barrel = source('src/index.ts');
    expect(barrel).toContain("from './contracts/final-public-record'");
    expect(barrel).toContain("from './evidence/final-writer'");
    expect(barrel).toContain("from './evidence/final-reader'");
    expect(barrel).not.toContain('writePublicRunRecordV3');
    expect(barrel).not.toContain('CURRENT_V3_LABEL');
    expect(barrel).not.toContain('classifyRunRecord');
    expect(barrel).not.toContain('planCaseForExecution');
  });

  it('keeps the strict-v4 child contracts free of the new port and the active modules frozen', () => {
    for (const relative of [
      'src/contracts/final-record-v4.ts',
      'src/contracts/final-record-reader.ts',
    ]) {
      const text = source(relative);
      expect(text, relative).not.toMatch(
        /from '\.\.\/(runtime|oracles|evidence|cli|browser|workflows|commands)\//,
      );
      expect(text, relative).not.toContain('node:fs');
      expect(text, relative).not.toContain('writeExclusiveRecordFile');
    }
  });
});

// ── Outcome vocabulary is never recovered from legacy authority ──────────────

describe('[P7-B2-E1] outcomes carry no legacy authority', () => {
  it('maps the classifier outcomes unchanged and never from a boolean', () => {
    const prepared = preparedCases[0] as PreparedCase;
    for (const outcome of [
      'PASS',
      'BUG',
      'HARNESS_BLOCKED',
      'ENVIRONMENT_FAILURE',
    ] as readonly Outcome[]) {
      const assembled = assembleFinalPublicRunRecordV4({
        child: childRecordFor(prepared),
        ...operationalFor(prepared, {
          behaviorOutcome: outcome === 'ENVIRONMENT_FAILURE' ? null : outcome,
          finalOutcome: outcome,
        }),
      });
      expect(assembled.ok, issueCodes(assembled).join(', ')).toBe(true);
      if (!assembled.ok) continue;
      expect(assembled.record.finalOutcome).toBe(outcome);
    }
    const invalidOutcome = assembleFinalPublicRunRecordV4({
      child: childRecordFor(prepared),
      ...operationalFor(prepared, { finalOutcome: 'NOT_AN_OUTCOME' as Outcome }),
    });
    expect(invalidOutcome.ok).toBe(false);
  });
});
