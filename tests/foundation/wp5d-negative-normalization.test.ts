import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadCatalogueBundle } from '../../src/catalogue/load';
import { resolveBindingFixture } from '../../src/catalogue/fixtures';
import { resolveBindingCoverage } from '../../src/coverage/resolve';
import { selectCoverage } from '../../src/coverage/select';
import { planCase } from '../../src/planner/plan-case';
import { runValidateAll } from '../../src/cli/validate';
import { resolveToolkitRoot } from '../../src/runtime/paths';
import {
  CASE_REQUEST_SCHEMA_VERSION,
  CHECK_RESULT_CONTRACT_SCHEMA_VERSION,
} from '../../src/contracts/schema-versions';
import {
  SETUP_CONSTRUCTOR_IDS,
  SETUP_NORMALIZATION_LITERAL_PROFILES,
  SETUP_NORMALIZATION_REFUSAL_REASONS,
  SETUP_REFUSAL_PROJECTION_CODE,
  setupFactsProvideCapabilityEvidence,
  setupRefusalSatisfiesNegativeNormalizationProof,
  type SetupNormalizationRefusalEvidence,
  type SetupRefusalPublicProjection,
} from '../../src/contracts/seam';
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
  buildSetupRefusalProjection,
  setupRefusalProjectionViolations,
} from '../../src/evidence/public-dto';
import { RunRecordWriteError } from '../../src/evidence/writer';
import { RedactionRejectedError } from '../../src/evidence/guard';
import {
  buildNestedObjectNegativeFixtureSnapshot,
  certifyNegativeNestedObjectNormalization,
} from '@/lib/artwork/verification/artworkSetupBoundary';

/**
 * WP5 Slice 5-D negative normalization proof — toolkit binding tests
 * (ADR 0016 R8/R10/R11.2/R11.3).
 *
 * Catalogue/planner truth, the closed setup-refusal projection, and the named
 * live acceptance predicate. The real owned-browser proof lives in the sibling
 * integration test and in the preserved CLI run record.
 */

function requestPath(name: string): string {
  return path.join(resolveToolkitRoot(), 'tests', 'integration', 'fixtures', name);
}

function loadRequest(name: string): unknown {
  return JSON.parse(readFileSync(requestPath(name), 'utf8')) as unknown;
}

const NEGATIVE_REQUEST = 'container-object-move-nested-not-normalized.request.json';

function productEvidence(): SetupNormalizationRefusalEvidence {
  const certification = certifyNegativeNestedObjectNormalization(
    buildNestedObjectNegativeFixtureSnapshot(),
  );
  if (certification.ok || certification.evidence === undefined) {
    throw new Error('the negative fixture must refuse with evaluation evidence');
  }
  return {
    phase: 'pre-hydration',
    code: 'FIXTURE_NOT_NORMALIZED',
    reason: certification.reason,
    constructorId: 'artwork.nested-object.normalization-negative.v1',
    constructorVersion: 1,
    fixtureId: 'artwork.fixture.nested-object.normalization-negative',
    fixtureVersion: 1,
    ...certification.evidence,
    mutationApplied: false,
    authorizationConsumed: true,
    lifecycle: 'SEALED',
    sealCreated: false,
    constructAttemptCount: 1,
    hydrateCallCount: 0,
    storeMutationCount: 0,
  };
}

function validProjection(): SetupRefusalPublicProjection {
  return buildSetupRefusalProjection(productEvidence());
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
  actionCycleId: 'negative-cycle-1',
  resolvedProfileFingerprint: RESOLVED_PROFILE_FINGERPRINT,
  readinessFingerprint: COMPONENT_FINGERPRINTS.readiness,
};

/** One UNUSABLE check: a refused setup never fabricates a behavior verdict. */
function unusableCheck(checkId: string): CorrectnessCheckResult {
  return {
    schemaVersion: CHECK_RESULT_CONTRACT_SCHEMA_VERSION,
    checkId,
    status: 'UNUSABLE',
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
      profileId: 'action-cycle-v1',
      timingCategory: 'INTERACTIVE_RENDER_V1',
      deadlineMs: 5000,
      signalWatchdogMs: 500,
      stableFrames: 3,
    },
  };
}

/** A complete closed strict v4 child; the refusal carries no family projection. */
function validChild(checks: readonly CorrectnessCheckResult[]): FinalCurrentChildRecordV4 {
  return {
    schemaVersion: 4,
    runId: 'vt-negative-record',
    caseId: 'case-negative',
    materializationFingerprint: HEX('3'),
    planFingerprint: HEX('4'),
    profile: 'diagnostic',
    observationId: null,
    resolvedProfileFingerprint: RESOLVED_PROFILE_FINGERPRINT,
    componentFingerprints: COMPONENT_FINGERPRINTS,
    actionCycles: [ACTION_CYCLE],
    requiredChecks: checks,
    nestedProjections: [actionCycleProjection()],
  };
}

/** The safe operational projections the current public v4 record adds. */
function operationalFields(
  overrides: Partial<Omit<AssembleFinalPublicRunRecordV4Input, 'child'>> = {},
): Omit<AssembleFinalPublicRunRecordV4Input, 'child'> {
  return {
    provenance: 'diagnostic-request',
    evidenceDepth: 'deep',
    environmentCellId: 'chromium-desktop-1440x1000',
    repository: { commit: null, dirty: null, lockfileDigest: HEX('5') },
    fingerprints: {
      registry: 'd',
      applicationInventory: 'e',
      operationCatalogue: 'f',
      adapterCatalogue: '0',
      workflowCatalogue: '1',
      workflowSteps: '2',
      coverageModel: '3',
      readinessProfile: 'action-cycle-v1@1',
      oracleProfile: 'geometry-delta-v1@1',
    },
    adapter: { adapterId: 'object-specialized', compatibilityVersion: 2 },
    workflow: { workflowId: 'object.move', version: 1 },
    fixture: {
      fixtureId: 'container-object-move-nested-not-normalized-v1',
      constructorId: 'artwork.nested-object.normalization-negative.v1',
      constructorVersion: 1,
    },
    targets: [],
    readiness: {
      profileId: 'action-cycle-v1',
      timingCategory: 'INTERACTIVE_RENDER_V1',
      deadlineMs: 5000,
      wakeSource: 'none',
      fallbackPollCount: 0,
      watchdogWaits: 0,
      rendererStableFrames: 0,
      timings: {},
    },
    behaviorOutcome: null,
    finalOutcome: 'HARNESS_BLOCKED',
    launch: {
      attempted: true,
      pid: 1,
      processGroupId: 1,
      readinessMs: 1,
      serverLogArtifactId: 'server.log',
    },
    ownership: {
      status: 'not-established',
      runId: 'vt-negative-record',
      allocationFailureCode: 'OWNERSHIP_UNKNOWN',
      requestedPort: null,
    },
    cleanup: null,
    diagnostics: [
      {
        code: SETUP_REFUSAL_PROJECTION_CODE,
        severity: 'blocking',
        detail: 'pre-hydration setup refusal',
        subjectId: null,
        applicationKind: null,
        context: { reason: 'FIXTURE_NOT_FIXED_POINT' },
      },
    ],
    runError: null,
    recordedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('negative normalization scenario and catalogue (ADR 0016 R1/R8)', () => {
  it('resolves the exact scenario, fixture, and checked-in request together', () => {
    const bundle = loadCatalogueBundle();
    const fixture = resolveBindingFixture(bundle.fixtureCatalogue, {
      subjectId: 'container/object',
      capability: 'move',
      scenarioId: 'move-nested-not-normalized',
    });
    expect(fixture).not.toBeNull();
    expect(fixture).toMatchObject({
      fixtureId: 'container-object-move-nested-not-normalized-v1',
      constructorId: 'artwork.nested-object.normalization-negative.v1',
      constructorVersion: 1,
      inputs: {},
    });
    expect(fixture?.semanticTargetRoles.map((role) => role.role)).toEqual(['target', 'witness']);

    const plan = planCase(loadRequest(NEGATIVE_REQUEST), { catalogues: bundle });
    expect(plan.status).toBe('PLANNED');
    if (plan.status !== 'PLANNED') return;
    expect(plan.request.schemaVersion).toBe(CASE_REQUEST_SCHEMA_VERSION);
    expect(plan.request.intent.scenario).toBe('move-nested-not-normalized');
    expect(plan.materializedCase.fixture?.constructorId).toBe(
      'artwork.nested-object.normalization-negative.v1',
    );
    expect(plan.materializedCase.fixture?.constructorVersion).toBe(1);
  });

  it('is diagnostic-only and earns no Release or Gate E credit', () => {
    const bundle = loadCatalogueBundle();
    const binding = resolveBindingCoverage({
      catalogue: bundle.coverageCatalogue,
      subjectId: 'container/object',
      capability: 'move',
    });
    expect(binding.status).toBe('resolved');
    if (binding.status !== 'resolved') return;
    const scenario = binding.model.scenarios.find(
      (entry) => entry.id === 'move-nested-not-normalized',
    );
    expect(scenario?.eligibility).toBe('diagnostic-only');
    // The scenario is not the subject of any Release obligation.
    expect(
      binding.model.obligations
        .filter((obligation) => obligation.requiredFor === 'release')
        .some(
          (obligation) =>
            obligation.match.kind === 'scenario' &&
            obligation.match.scenarioId === 'move-nested-not-normalized',
        ),
    ).toBe(false);

    const plan = planCase(loadRequest(NEGATIVE_REQUEST), { catalogues: bundle });
    expect(plan.status).toBe('PLANNED');
    if (plan.status !== 'PLANNED') return;
    expect(plan.outputs.coverageAttribution.releaseCreditEligible).toBe(false);
    expect(plan.outputs.coverageAttribution.releaseCreditBlockers).toContain(
      'scenario-not-release-required',
    );
    expect(setupFactsProvideCapabilityEvidence()).toBe(false);
  });

  it('cannot satisfy risk-nested-rotated and never enters a Release Selection Manifest', () => {
    const bundle = loadCatalogueBundle();
    const binding = resolveBindingCoverage({
      catalogue: bundle.coverageCatalogue,
      subjectId: 'container/object',
      capability: 'move',
    });
    if (binding.status !== 'resolved') throw new Error('coverage model must resolve');

    const selection = selectCoverage({
      model: binding.model,
      modelFingerprint: binding.modelFingerprint,
      profile: 'release',
    });
    expect(selection.cases.some((entry) => entry.scenarioId === 'move-nested-not-normalized')).toBe(
      false,
    );
    // The rotated-ancestry assignment remains owned by the positive release
    // scenario, so the diagnostic negative cannot steal the risk obligation.
    const owner = selection.cases.find(
      (entry) =>
        entry.assignments.ancestry === 'ancestry-rotated' &&
        entry.assignments['child-class'] === 'child-object',
    );
    expect(owner?.scenarioId).toBe('move-nested-rotated');
    expect(owner?.releaseEligible).toBe(true);
    expect(
      selection.obligationMappings.some(
        (mapping) =>
          mapping.obligationId === 'risk-nested-rotated' &&
          owner !== undefined &&
          mapping.caseKeys.includes(owner.caseKey),
      ),
    ).toBe(true);
  });

  it('produces distinct case, materialization, and plan identities', () => {
    const bundle = loadCatalogueBundle();
    const positive = planCase(loadRequest('container-object-move.request.json'), {
      catalogues: bundle,
    });
    const bug = planCase(loadRequest('container-object-move.bug.request.json'), {
      catalogues: bundle,
    });
    const ambiguous = planCase(loadRequest('container-object-move-ambiguous.request.json'), {
      catalogues: bundle,
    });
    const negative = planCase(loadRequest(NEGATIVE_REQUEST), { catalogues: bundle });
    for (const plan of [positive, bug, ambiguous, negative]) {
      if (plan.status !== 'PLANNED') throw new Error('expected four planned cases');
    }
    if (
      positive.status !== 'PLANNED' ||
      bug.status !== 'PLANNED' ||
      ambiguous.status !== 'PLANNED' ||
      negative.status !== 'PLANNED'
    ) {
      return;
    }
    const identities = [positive, bug, ambiguous, negative];
    expect(new Set(identities.map((plan) => plan.caseId)).size).toBe(4);
    expect(new Set(identities.map((plan) => plan.materializationFingerprint)).size).toBe(4);
    expect(new Set(identities.map((plan) => plan.planFingerprint)).size).toBe(4);
  });

  it('rejects unknown request fields and keeps the positive scenario on the normal v2 constructor', () => {
    const bundle = loadCatalogueBundle();
    const raw = loadRequest(NEGATIVE_REQUEST) as {
      intent: Record<string, unknown>;
    };
    const tampered = {
      ...(raw as Record<string, unknown>),
      intent: {
        ...raw.intent,
        rawTree: { nodes: {} },
        literalProfile: 'known-malformed-v1-negative',
      },
    };
    expect(planCase(tampered, { catalogues: bundle }).status).toBe('HARNESS_BLOCKED');

    const positiveFixture = resolveBindingFixture(bundle.fixtureCatalogue, {
      subjectId: 'container/object',
      capability: 'move',
      scenarioId: 'move-nested-rotated',
    });
    expect(positiveFixture?.constructorId).toBe('artwork.nested-object.v2');
    expect(positiveFixture?.constructorVersion).toBe(2);
    // The negative constructor is registered but the positive scenario never
    // selects it.
    expect([...SETUP_CONSTRUCTOR_IDS]).toContain('artwork.nested-object.normalization-negative.v1');
  });

  it('keeps the generic-engine Subject branch audit at zero', () => {
    const result = runValidateAll();
    expect(result.status).toBe('PASS');
    expect(result.details?.branchAudit.passed).toBe(true);
    expect(result.details?.branchAudit.violations).toEqual([]);
  });
});

describe('closed setup-refusal projection (ADR 0016 R7/R11.3)', () => {
  it('accepts exactly the closed negative projection and rejects every deviation', () => {
    const projection = validProjection();
    expect(setupRefusalProjectionViolations({ ...projection })).toEqual([]);
    expect(projection).toMatchObject({
      phase: 'pre-hydration',
      code: SETUP_REFUSAL_PROJECTION_CODE,
      reason: 'FIXTURE_NOT_FIXED_POINT',
      literalProfile: 'known-malformed-v1-negative',
      targetResolutionCount: 0,
      readinessEntered: false,
      observationCaptureCount: 0,
      oracleExecutionCount: 0,
      nativePointerDispatchCount: 0,
    });
    expect(SETUP_NORMALIZATION_LITERAL_PROFILES).toContain('known-malformed-v1-negative');
    expect(SETUP_NORMALIZATION_REFUSAL_REASONS).toContain('FIXTURE_NOT_FIXED_POINT');

    const withRawTree = { ...projection, rawTree: { layers: [{ id: 'object-outer' }] } };
    expect(setupRefusalProjectionViolations(withRawTree)).toContain('unknown-key:rawTree');

    const missing = { ...projection } as Record<string, unknown>;
    delete missing.sealCreated;
    expect(setupRefusalProjectionViolations(missing)).toContain('missing-key:sealCreated');

    const wrongReason = { ...projection, reason: 'NOT_A_REASON' };
    expect(setupRefusalProjectionViolations(wrongReason)).toContain('reason:not-closed');

    const wrongCode = { ...projection, code: 'SETUP_INPUT_INVALID' };
    expect(setupRefusalProjectionViolations(wrongCode)).toContain('code:not-exact');

    const activeLeak = {
      ...projection,
      active: { ...projection.active, layers: [{ id: 'object-outer' }] },
    };
    expect(setupRefusalProjectionViolations(activeLeak)).toContain('active:unknown-key:layers');

    const nonzero = { ...projection, nativePointerDispatchCount: 1 };
    expect(setupRefusalProjectionViolations(nonzero)).toContain(
      'nativePointerDispatchCount:not-exact',
    );
  });

  it('writes the strict v4 record with the closed refusal projection and refuses an extended shape', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'verify-negative-record-'));
    try {
      const written = writeFinalPublicRunRecordV4({
        child: validChild([unusableCheck('move-nested-not-normalized')]),
        ...operationalFields(),
        evidenceRoot: dir,
      });
      const record = JSON.parse(readFileSync(written.path, 'utf8')) as {
        schemaVersion: number;
        behaviorOutcome: unknown;
        finalOutcome: string;
        diagnostics: { code: string; context?: { reason?: string } }[];
      };
      // The current record is the strict v4 child; the refused setup never
      // fabricates a behavior verdict and still carries the exact projection code.
      expect(record.schemaVersion).toBe(4);
      expect(record.behaviorOutcome).toBeNull();
      expect(record.finalOutcome).toBe('HARNESS_BLOCKED');
      const refusal = record.diagnostics.find(
        (entry) => entry.code === SETUP_REFUSAL_PROJECTION_CODE,
      );
      expect(refusal?.context?.reason).toBe('FIXTURE_NOT_FIXED_POINT');
      // The closed setup-refusal projection itself is still exact.
      expect(setupRefusalProjectionViolations({ ...validProjection() })).toEqual([]);

      const read = readFinalPublicRecordFile(written.path);
      expect(read.kind).toBe('current-v4');
      expect(read.current).toBe(true);
      expect(read.legacy).toBe(false);

      // An extended shape that reintroduces the removed legacy `setupRefusal`
      // authority is refused before any byte reaches disk.
      const dir2 = mkdtempSync(path.join(os.tmpdir(), 'verify-negative-record-'));
      try {
        const extended = {
          ...validChild([unusableCheck('move-nested-not-normalized')]),
          setupRefusal: validProjection(),
        } as unknown as FinalCurrentChildRecordV4;
        expect(() =>
          writeFinalPublicRunRecordV4({
            child: extended,
            ...operationalFields(),
            evidenceRoot: dir2,
          }),
        ).toThrow(RunRecordWriteError);
        expect(existsSync(path.join(dir2, 'run-record.json'))).toBe(false);
      } finally {
        rmSync(dir2, { recursive: true, force: true });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps the redaction guard ahead of the current strict-v4 writer', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'verify-negative-redaction-'));
    try {
      // A closed setup-refusal diagnostic never rescues a prohibited private value.
      expect(() =>
        writeFinalPublicRunRecordV4({
          child: validChild([unusableCheck('move-nested-not-normalized')]),
          ...operationalFields({ runError: '/Users/example-user/private/secret.log' }),
          evidenceRoot: dir,
        }),
      ).toThrow(RedactionRejectedError);
      expect(existsSync(path.join(dir, 'run-record.json'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('names ADR 0015 live outcome 5 on exactly one refusal tuple', () => {
    const projection = validProjection();
    const base = {
      setupRefusal: projection,
      behaviorOutcome: null,
      finalOutcome: 'HARNESS_BLOCKED',
      launchAttempted: true,
      cleanupComplete: true,
    };
    expect(setupRefusalSatisfiesNegativeNormalizationProof(base)).toBe(true);
    expect(
      setupRefusalSatisfiesNegativeNormalizationProof({
        ...base,
        setupRefusal: { ...projection, reason: 'NEGATIVE_FIXTURE_LITERALS_MISMATCH' },
      }),
    ).toBe(false);
    expect(
      setupRefusalSatisfiesNegativeNormalizationProof({
        ...base,
        setupRefusal: { ...projection, code: 'SETUP_INPUT_INVALID' } as never,
      }),
    ).toBe(false);
    expect(
      setupRefusalSatisfiesNegativeNormalizationProof({
        ...base,
        setupRefusal: { ...projection, nativePointerDispatchCount: 1 } as never,
      }),
    ).toBe(false);
    expect(
      setupRefusalSatisfiesNegativeNormalizationProof({
        ...base,
        behaviorOutcome: 'HARNESS_BLOCKED',
      }),
    ).toBe(false);
    expect(
      setupRefusalSatisfiesNegativeNormalizationProof({ ...base, launchAttempted: false }),
    ).toBe(false);
    expect(
      setupRefusalSatisfiesNegativeNormalizationProof({ ...base, cleanupComplete: false }),
    ).toBe(false);
    expect(setupRefusalSatisfiesNegativeNormalizationProof({ ...base, setupRefusal: null })).toBe(
      false,
    );
  });
});
