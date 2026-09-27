/**
 * WP5 Slice 5-F — frontend serialize/restore catalogue, contract, Oracle,
 * projection, and run-record migration tests (ADR 0019 R5–R7/R11; ADR 0021 N7).
 *
 * These are foundation (pure) tests for the closed restore workflow/steps, the
 * delivered restore fixtures, the closed setup recipes and Save control, the
 * closed restore Oracle classification, the closed public restore projection
 * validation, and the schema-v3 durable record with the restore projection.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { loadCatalogueBundle } from '../../src/catalogue/load';
import { loadDiagnosticSuite } from '../../src/catalogue/suite';
import {
  REPRESENTATIVE_SUITE_CASE_COUNT,
  REPRESENTATIVE_SUITE_ID,
} from '../../src/contracts/suite';
import { resolveBindingFixture } from '../../src/catalogue/fixtures';
import { PUBLIC_CONTROLS } from '../../src/browser/public-controls';
import {
  FRONTEND_RESTORE_V1_DEADLINE_MS,
  FRONTEND_RESTORE_V1_TIMING_CATEGORY,
  RESTORE_CREATE_PATH,
  RESTORE_ORACLE_PROFILE_ID,
  RESTORE_REQUIRED_CHECKS,
  RESTORE_SETUP_RECIPES,
  RESTORE_TRANSITION_PROFILE_ID,
  resolveRestoreSetupRecipe,
  restoreWorkflowStepsAgree,
  type RestoreOracleFacts,
} from '../../src/contracts/restore-observation';
import { evaluateRestoreOracle } from '../../src/oracles/restore';
import {
  restoreEvidenceViolations,
  type PublicRestoreEvidenceV1,
} from '../../src/evidence/public-dto';
import { CHECK_RESULT_CONTRACT_SCHEMA_VERSION } from '../../src/contracts/schema-versions';
import type {
  ActionCycleCorrectnessIdentity,
  CorrectnessCheckResult,
} from '../../src/contracts/correctness';
import type {
  FinalCurrentChildRecordV4,
  FinalNestedProjectionV4,
} from '../../src/contracts/final-record-v4';
import type { AssembleFinalPublicRunRecordV4Input } from '../../src/contracts/final-public-record';
import { readFinalPublicRecordFile } from '../../src/evidence/final-reader';
import { writeFinalPublicRunRecordV4 } from '../../src/evidence/final-writer';
import {
  classifyLegacyRunRecord,
  LEGACY_V1_LABEL,
  ACCEPTED_PRE_5F_V2_LABEL,
} from '../../src/evidence/reader';
import { resolveWorkflowSteps } from '../../src/workflows/steps';
import { resolveReadinessProfile } from '../../src/readiness/profile-registry';
import { resolveOracleProfile } from '../../src/oracles/profile-registry';

const roots: string[] = [];

function tempRoot(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'verify-wp5f-restore-'));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  while (roots.length > 0) {
    const dir = roots.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function validFacts(): RestoreOracleFacts {
  return {
    schemaVersion: 1,
    requiredChecks: RESTORE_REQUIRED_CHECKS,
    transition: {
      saveDispatchedOnce: true,
      createRequestCount: 1,
      createMethodMatches: true,
      createPathMatches: true,
      createContentTypeMatches: true,
      createAfterEpoch: true,
      getRequestCount: 1,
      getMethodMatches: true,
      getPathMatches: true,
      redirectObserved: true,
      navigateRouteMatches: true,
      documentIdentityDistinct: true,
      restoredHistoryClean: true,
      harnessHydrateCalls: 0,
      harnessStoreMutationCalls: 0,
    },
    meaning: {
      normalizedStructurallyEqual: true,
      normalizedFingerprintEqual: true,
      sourceFingerprint: 'a'.repeat(16),
      restoredFingerprint: 'a'.repeat(16),
      inventoryPreserved: true,
      persistenceLossDetected: false,
    },
    rawSemantics: {
      crosswordPresent: true,
      generationSeed: 123456789,
      words: ['MAKEIT', 'CROSSWORD', 'HELLO'],
      layoutDigest: 'd'.repeat(64),
      restoredSeedMatches: true,
      restoredWordsMatch: true,
      restoredLayoutDigestMatches: true,
      rawConfigPresent: true,
      rawServerMetadataPresent: true,
      normalizedHasNoIdKey: true,
      normalizedHasNoConfigKey: true,
      normalizedHasNoServerMetadata: true,
      volatileIdsDiffer: true,
    },
  };
}

function validProjection(): PublicRestoreEvidenceV1 {
  const side = (documentId: string, route: string) => ({
    documentId,
    documentEpoch: 1,
    route,
    observationId: `${documentId}:3`,
    observationRevision: 3,
    normalizedFingerprint: 'f'.repeat(16),
    canonicalDigest: 'c'.repeat(64),
    layoutCount: 2,
    layerCount: 3,
    historyPastDepth: 3,
    historyFutureDepth: 0,
    historyBaselineClean: false,
  });
  return {
    schemaVersion: 1,
    normalizationProfileId: 'artwork-product-meaning-v1',
    readinessProfileId: 'frontend-restore-transition-v1',
    oracleProfileId: 'frontend-restore-v1',
    timingCategory: 'FRONTEND_RESTORE_V1',
    deadlineMs: 15000,
    frontendOnly: true,
    backendPersistenceClaimed: false,
    scenarioId: 'serialize-raw-semantic',
    source: side('source-document', '/artwork/editor') as PublicRestoreEvidenceV1['source'],
    restored: side(
      'restored-document',
      '/artwork/editor/424242',
    ) as PublicRestoreEvidenceV1['restored'],
    setup: [
      {
        role: 'setup-text',
        stepCount: 2,
        historyPastDepth: 1,
        historyFutureDepth: 0,
        historyBaselineClean: false,
        meaningFingerprint: 'm'.repeat(16),
      },
    ],
    route: {
      saveControlAccessibleName: 'Save',
      saveDispatchCount: 1,
      createMethod: 'POST',
      createPath: '/api/artwork/create',
      createContentType: 'application/json',
      createRequestCount: 1,
      redirectPath: '/artwork',
      redirectObserved: true,
      getMethod: 'GET',
      getPath: '/api/artwork/424242',
      getRequestCount: 1,
      navigatePath: '/artwork/editor/424242',
    },
    transport: {
      requestLogicalId: 'restore-request:post:/api/artwork/create:1',
      requestDtoLogicalId: 'restore-dto:abc',
      responseLogicalId: 'restore-response:424242',
      responseArtworkId: 424242,
      responseLayoutCount: 2,
      responseMessage: 'OK',
      responseTimestamp: '2026-01-01T00:00:00.000Z',
      rawArtifactId: 'restore-raw:abc',
      rawArtifactRedactionPassed: true,
    },
    exclusions: {
      volatileIdsDiffer: true,
      rawConfigPresent: true,
      rawServerMetadataPresent: true,
      normalizedHasNoIdKey: true,
      normalizedHasNoConfigKey: true,
      normalizedHasNoServerMetadata: true,
    },
    rawSemantics: {
      crosswordPresent: true,
      generationSeed: 123456789,
      words: ['MAKEIT', 'CROSSWORD', 'HELLO'],
      layoutDigest: 'd'.repeat(64),
      restoredSeedMatches: true,
      restoredWordsMatches: true,
      restoredLayoutDigestMatches: true,
      layoutDigestAlgorithm: 'sha256',
      layoutDigestDomain: 'makeit:restore-crossword-layout:v1',
    },
    documentIdentityDistinct: true,
    normalizedStructurallyEqual: true,
    normalizedFingerprintEqual: true,
    inventoryPreserved: true,
    persistenceLossDetected: false,
    harnessHydrateCalls: 0,
    harnessStoreMutationCalls: 0,
    checks: [
      { checkId: 'serialize.raw-semantic', passed: true, evidenceIds: ['observation:a->b'] },
      { checkId: 'serialize.roundtrip', passed: true, evidenceIds: ['observation:a->b'] },
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
  actionCycleId: 'restore-cycle-1',
  resolvedProfileFingerprint: RESOLVED_PROFILE_FINGERPRINT,
  readinessFingerprint: COMPONENT_FINGERPRINTS.readiness,
};

/** One closed three-state check bound to the single restore Action Cycle. */
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
      profileId: RESTORE_TRANSITION_PROFILE_ID,
      timingCategory: FRONTEND_RESTORE_V1_TIMING_CATEGORY,
      deadlineMs: FRONTEND_RESTORE_V1_DEADLINE_MS,
      signalWatchdogMs: 500,
      stableFrames: 3,
    },
  };
}

function restoreProjection(checks: readonly CorrectnessCheckResult[]): FinalNestedProjectionV4 {
  return {
    schemaVersion: 4,
    family: 'restore',
    normalizationProfileId: 'artwork-product-meaning-v1',
    readinessProfileId: RESTORE_TRANSITION_PROFILE_ID,
    oracleProfileId: RESTORE_ORACLE_PROFILE_ID,
    timingCategory: FRONTEND_RESTORE_V1_TIMING_CATEGORY,
    deadlineMs: FRONTEND_RESTORE_V1_DEADLINE_MS,
    scenarioId: 'serialize-raw-semantic',
    sourceDocumentId: 'source-document',
    restoredDocumentId: 'restored-document',
    actionCycleRef: ACTION_CYCLE.actionCycleId,
    checks,
  };
}

/** A complete closed strict v4 child carrying the restore nested projection. */
function validChild(checks: readonly CorrectnessCheckResult[]): FinalCurrentChildRecordV4 {
  return {
    schemaVersion: 4,
    runId: 'run-wp5f-restore',
    caseId: 'case-wp5f-restore',
    materializationFingerprint: HEX('3'),
    planFingerprint: HEX('4'),
    profile: 'diagnostic',
    observationId: 'obs-restore',
    resolvedProfileFingerprint: RESOLVED_PROFILE_FINGERPRINT,
    componentFingerprints: COMPONENT_FINGERPRINTS,
    actionCycles: [ACTION_CYCLE],
    requiredChecks: checks,
    nestedProjections: [actionCycleProjection(), restoreProjection(checks)],
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
      readinessProfile: `${RESTORE_TRANSITION_PROFILE_ID}@1`,
      oracleProfile: `${RESTORE_ORACLE_PROFILE_ID}@1`,
    },
    adapter: { adapterId: 'default', compatibilityVersion: 1 },
    workflow: { workflowId: 'shared.serialize', version: 1 },
    fixture: {
      fixtureId: 'artwork-editor-serialize-restore-mixed-raw-v1',
      constructorId: 'artwork.two-layout-text.v1',
      constructorVersion: 1,
    },
    targets: [],
    readiness: {
      profileId: RESTORE_TRANSITION_PROFILE_ID,
      timingCategory: FRONTEND_RESTORE_V1_TIMING_CATEGORY,
      deadlineMs: FRONTEND_RESTORE_V1_DEADLINE_MS,
      wakeSource: 'already-advanced',
      fallbackPollCount: 0,
      watchdogWaits: 0,
      rendererStableFrames: 3,
      timings: {},
    },
    behaviorOutcome: 'PASS',
    finalOutcome: 'PASS',
    launch: {
      attempted: false,
      pid: null,
      processGroupId: null,
      readinessMs: null,
      serverLogArtifactId: null,
    },
    ownership: {
      status: 'not-established',
      runId: 'run-wp5f-restore',
      allocationFailureCode: 'OWNERSHIP_UNKNOWN',
      requestedPort: null,
    },
    cleanup: null,
    diagnostics: [],
    runError: null,
    recordedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('[WP5 Slice 5-F] restore contract, fixtures, Oracle, and projection', () => {
  it('declares the closed shared.serialize workflow and both restore fixtures', () => {
    const bundle = loadCatalogueBundle();
    const serialize = resolveWorkflowSteps(bundle.workflowStepCatalogue, 'shared.serialize');
    expect(serialize?.capability).toBe('frontendSerializeRestore');
    expect(restoreWorkflowStepsAgree(serialize?.steps ?? [])).toBe(true);
    expect(
      restoreWorkflowStepsAgree([
        { stepId: 'serialize.save', primitive: 'control.activate', targetRole: 'control:save' },
      ]),
    ).toBe(false);

    const normalized = resolveBindingFixture(bundle.fixtureCatalogue, {
      subjectId: 'artwork/editor',
      capability: 'frontendSerializeRestore',
      scenarioId: 'serialize-roundtrip',
    });
    const mixed = resolveBindingFixture(bundle.fixtureCatalogue, {
      subjectId: 'artwork/editor',
      capability: 'frontendSerializeRestore',
      scenarioId: 'serialize-raw-semantic',
    });
    expect(normalized?.fixtureId).toBe('artwork-editor-serialize-restore-normalized-v1');
    expect(mixed?.fixtureId).toBe('artwork-editor-serialize-restore-mixed-raw-v1');
    expect(normalized?.semanticTargetRoles.map((role) => role.role)).toEqual(['setup-text']);
    expect(mixed?.semanticTargetRoles.map((role) => role.role)).toEqual([
      'setup-text',
      'setup-image-placeholder',
      'setup-crossword',
    ]);
  });

  it('exposes the exact Save control and closed setup recipes', () => {
    expect(PUBLIC_CONTROLS.save).toBe('Save');
    expect(Object.keys(RESTORE_SETUP_RECIPES).sort()).toEqual([
      'setup-crossword',
      'setup-image-placeholder',
      'setup-text',
    ]);
    expect(resolveRestoreSetupRecipe('setup-text')?.actions.map((a) => a.primitive)).toEqual([
      'control.activate',
      'control.activate',
    ]);
    expect(resolveRestoreSetupRecipe('setup-crossword')?.actions[0]?.primitive).toBe(
      'selection.clear',
    );
    expect(resolveRestoreSetupRecipe('setup-text')?.actions.every((a) => a.accessibleName)).toBe(
      true,
    );
  });

  it('resolves the closed readiness/Oracle profiles', () => {
    const readiness = resolveReadinessProfile(RESTORE_TRANSITION_PROFILE_ID);
    expect(readiness?.oracleProfileId).toBe(RESTORE_ORACLE_PROFILE_ID);
    expect(readiness?.profile.deadlineMs).toBe(FRONTEND_RESTORE_V1_DEADLINE_MS);
    expect(readiness?.profile.timingCategory).toBe(FRONTEND_RESTORE_V1_TIMING_CATEGORY);
    expect(resolveOracleProfile(RESTORE_ORACLE_PROFILE_ID)?.kind).toBe('frontend-restore');
    expect(RESTORE_CREATE_PATH).toBe('/api/artwork/create');
  });

  it('classifies the closed restore Oracle: PASS, BUG, and harness-invalid', () => {
    const pass = evaluateRestoreOracle(validFacts());
    expect(pass.passed).toBe(true);
    expect(pass.harnessInvalid).toBe(false);
    expect(pass.checks).toEqual([
      { checkId: 'serialize.raw-semantic', passed: true },
      { checkId: 'serialize.roundtrip', passed: true },
    ]);

    const wrongMeaning = validFacts();
    wrongMeaning.meaning.normalizedStructurallyEqual = false;
    wrongMeaning.meaning.persistenceLossDetected = true;
    const bug = evaluateRestoreOracle(wrongMeaning);
    expect(bug.passed).toBe(false);
    expect(bug.harnessInvalid).toBe(false);
    expect(bug.checks.find((check) => check.checkId === 'serialize.roundtrip')?.passed).toBe(false);
    expect(bug.checks.find((check) => check.checkId === 'serialize.raw-semantic')?.passed).toBe(
      true,
    );

    const missingTransition = validFacts();
    missingTransition.transition.getRequestCount = 0;
    missingTransition.transition.redirectObserved = false;
    const blocked = evaluateRestoreOracle(missingTransition);
    expect(blocked.passed).toBe(false);
    expect(blocked.harnessInvalid).toBe(false);
    expect(blocked.diagnostics.map((entry) => entry.code)).toContain(
      'RESTORE_DOCUMENT_TRANSITION_MISSING',
    );

    const rawMismatch = validFacts();
    rawMismatch.rawSemantics.restoredLayoutDigestMatches = false;
    rawMismatch.rawSemantics.normalizedHasNoConfigKey = false;
    const rawFailed = evaluateRestoreOracle(rawMismatch);
    expect(
      rawFailed.checks.find((check) => check.checkId === 'serialize.raw-semantic')?.passed,
    ).toBe(false);
    expect(rawFailed.diagnostics.map((entry) => entry.code)).toContain(
      'RESTORE_RAW_SEMANTIC_MISMATCH',
    );

    const badSchema = evaluateRestoreOracle({
      ...validFacts(),
      schemaVersion: 2,
    } as unknown as RestoreOracleFacts);
    expect(badSchema.harnessInvalid).toBe(true);
  });

  it('accepts the closed restore projection and rejects an extended or dishonest one', () => {
    expect(
      restoreEvidenceViolations(validProjection() as unknown as Record<string, unknown>),
    ).toEqual([]);

    const extra = validProjection() as unknown as Record<string, unknown>;
    extra.rawUrl = 'http://127.0.0.1/private';
    expect(restoreEvidenceViolations(extra)).toContain('restore:unknown-key:rawUrl');

    const dishonest = validProjection() as unknown as Record<string, unknown>;
    (dishonest.exclusions as Record<string, unknown>).normalizedHasNoConfigKey = false;
    expect(restoreEvidenceViolations(dishonest)).toContain(
      'exclusions:normalizedHasNoConfigKey:not-true',
    );

    const notClean = validProjection() as unknown as Record<string, unknown>;
    notClean.persistenceLossDetected = true;
    expect(restoreEvidenceViolations(notClean)).toContain('persistenceLossDetected:not-exact');
  });

  it('writes and classifies a strict v4 record carrying the closed restore projection', () => {
    const root = tempRoot();
    const checks = RESTORE_REQUIRED_CHECKS.map(statusCheck);
    const written = writeFinalPublicRunRecordV4({
      child: validChild(checks),
      ...operationalFields(),
      evidenceRoot: root,
    });
    const parsed = JSON.parse(readFileSync(written.path, 'utf8')) as {
      schemaVersion: number;
      nestedProjections: { family: string; scenarioId?: string }[];
    };
    expect(parsed.schemaVersion).toBe(4);
    const restore = parsed.nestedProjections.find((entry) => entry.family === 'restore');
    expect(restore?.scenarioId).toBe('serialize-raw-semantic');
    const classified = readFinalPublicRecordFile(written.path);
    expect(classified.kind).toBe('current-v4');
    expect(classified.current).toBe(true);
    // Legacy v1/v2/v3 records remain explicitly discriminated, never coerced.
    expect(classifyLegacyRunRecord({ schemaVersion: 1 }).label).toBe(LEGACY_V1_LABEL);
    expect(classifyLegacyRunRecord({ schemaVersion: 2 }).label).toBe(ACCEPTED_PRE_5F_V2_LABEL);
    expect(classifyLegacyRunRecord({ schemaVersion: 9 }).kind).toBe('unknown');
  });

  it('declares the representative diagnostic suite over the delivered stable requests', () => {
    const skillRoot = path.resolve(__dirname, '..', '..');
    expect(
      existsSync(path.join(skillRoot, 'cases', 'diagnostic', 'suites', 'representative.v1.json')),
    ).toBe(true);
    const suite = loadDiagnosticSuite(REPRESENTATIVE_SUITE_ID);
    expect(suite.suite.cases).toHaveLength(REPRESENTATIVE_SUITE_CASE_COUNT);
    for (const entry of suite.suite.cases) {
      expect(entry.request.startsWith('cases/diagnostic/requests/')).toBe(true);
    }
  });
});
