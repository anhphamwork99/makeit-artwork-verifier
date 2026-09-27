import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { generateCrosswordLayout } from '@/lib/artwork/crosswordEngine/layout';

import { loadCatalogueBundle } from '../../src/catalogue/load';
import { resolveBindingFixture } from '../../src/catalogue/fixtures';
import { resolveAdapterImplementation, ADAPTER_IMPLEMENTATIONS } from '../../src/adapters/registry';
import {
  CROSSWORD_GENERATION_READINESS_PROFILE,
  GENERATED_CROSSWORD_SEMANTIC_PROFILE,
  GENERATED_SPECIALIZED_ADAPTER_ID,
  GENERATED_SPECIALIZED_COMPATIBILITY_VERSION,
  generatedSpecializedAdapter,
} from '../../src/adapters/generated-specialized';
import {
  buildAdapterResolutionBaseline,
  rolesForPhase,
  type AdapterElementFact,
} from '../../src/contracts/adapter';
import {
  CROSSWORD_CLOCK_PROFILE_ID,
  CROSSWORD_COMPARISON_PROFILE_ID,
  CROSSWORD_GENERATION_CAPTURE_PROFILE_ID,
  CROSSWORD_OBSERVATION_SCHEMA_VERSION,
  CROSSWORD_RELEASE_EPOCHS,
  CROSSWORD_REQUIRED_CHECKS,
  CROSSWORD_SEMANTIC_PROFILE,
  crosswordWordsAreAuthoritative,
  parseCrosswordClockProfile,
  validateCrosswordExecutionChild,
  validateCrosswordExecutionSet,
  type CrosswordExecutionRole,
} from '../../src/contracts/crossword-observation';
import {
  CROSSWORD_DEFAULT_WORDS,
  CROSSWORD_GENERATOR_SOURCE_PATH,
  CROSSWORD_STORE_SOURCE_PATH,
  compareCrosswordExecutions,
  crosswordSemanticDigest,
  crosswordSemanticPayloadFromLayerShape,
  crosswordWordsFingerprint,
  validateCrosswordSourceContract,
} from '../../src/contracts/crossword';
import { WALL_CLOCK_NAMESPACE, WALL_CLOCK_PROVIDER_ID } from '../../src/contracts/wall-clock';
import { DIAGNOSTIC_SEVERITY } from '../../src/contracts/diagnostics';
import {
  rasterRegionAgreesWithTarget,
  type GeneratedVectorRasterRecordView,
} from '../../src/contracts/raster';
import {
  evaluateCrosswordCaptureCoherence,
  executeCrosswordPlan,
  withinDeadline,
} from '../../src/runtime/execute-crossword-plan';
import {
  deriveMaterializationFingerprint,
  derivePlanFingerprint,
} from '../../src/canonical/identity';
import {
  CROSSWORD_ORACLE_PROFILE_ID,
  evaluateCrosswordOracle,
  type CrosswordOracleEvaluation,
  type CrosswordOracleInput,
} from '../../src/oracles/crossword';
import {
  evaluateCrosswordLiveChecks,
  type CrosswordLiveEvaluationObservation,
} from '../../src/adapters/crossword-live-facts';
import { CHECK_RESULT_CONTRACT_SCHEMA_VERSION } from '../../src/contracts/schema-versions';
import {
  FINAL_NESTED_PROJECTION_SCHEMA_VERSION,
  type FinalCrosswordProjectionV4,
} from '../../src/contracts/final-record-v4';
import type {
  ActionCycleCorrectnessIdentity,
  CorrectnessCheckResult,
  CrosswordEvidenceFact,
} from '../../src/index';
import { resolveOracleProfile } from '../../src/oracles/profile-registry';
import { resolveReadinessProfile } from '../../src/readiness/profile-registry';
import { classifyOutcome } from '../../src/runtime/outcomes';
import { resolveExecutionSupport } from '../../src/planner/execution-support';
import { planCase, planCaseForExecution } from '../../src/planner/plan-case';
import { deriveLaunchability } from '../../src/planner/launchability';
import { resolveWorkflowSteps } from '../../src/workflows/steps';
import { executeWorkflowSteps } from '../../src/workflows/execute';
import type { CaseIntent } from '../../src/contracts/case-model';
import { defaultBundle, diagnosticRequest, planned } from './helpers';
import { serializePublicRecord, isRedactionRejected } from '../../src/evidence/guard';
import { fixtureHasPostActionRoles } from '../../src/contracts/adapter';
import { resolveBindingFixture as resolveFixture } from '../../src/catalogue/fixtures';

/**
 * WP5 Slice 5-E generated-Crossword contract tests (ADR 0017; ADR 0018 CR3–CR9).
 *
 * These are pure-contract tests over the real product generator plus catalogue
 * data. No browser layout, seed, or digest of a live execution is stored as an
 * expectation: every digest below is recomputed from the accepted generator.
 */

const WORDS = [...CROSSWORD_DEFAULT_WORDS];
const BASELINE_A = '2026-01-02T03:04:05.000Z';
const BASELINE_B = '1970-01-02T10:17:36.789Z';
const BASELINE_COLLISION = '2026-01-02T03:04:05.002Z';

const SEED_A = Date.parse(BASELINE_A);
const SEED_B = Date.parse(BASELINE_B);
const SEED_COLLISION = Date.parse(BASELINE_COLLISION);

const STORE_SOURCE = readFileSync(CROSSWORD_STORE_SOURCE_PATH, 'utf8');
const GENERATOR_SOURCE = readFileSync(CROSSWORD_GENERATOR_SOURCE_PATH, 'utf8');
const SOURCE_FINGERPRINT = validateCrosswordSourceContract({
  storeSource: STORE_SOURCE,
  generatorSource: GENERATOR_SOURCE,
}).fingerprint;

function clock(baselines: readonly [string, string, string]) {
  return {
    schemaVersion: 1,
    profileId: CROSSWORD_CLOCK_PROFILE_ID,
    providerId: WALL_CLOCK_PROVIDER_ID,
    comparisonProfileId: CROSSWORD_COMPARISON_PROFILE_ID,
    baselines: [...baselines],
  };
}

function generatedVectorRaster(input: {
  id: string;
  rendererFingerprint: string;
  rasterFingerprint: string;
}): GeneratedVectorRasterRecordView {
  // The exact projection quantization must hold: ceil(40 × 1) = 40.
  const backingWidth = 40;
  const backingHeight = 40;
  return {
    rasterSchemaVersion: 3,
    authorityKind: 'generated-vector-projection-v1',
    id: input.id,
    kind: 'crossword',
    mounted: true,
    status: 'ready',
    observation: {
      schemaVersion: 1,
      documentId: `doc-${input.id}`,
      documentEpoch: 1,
      bridgeVersion: 7,
      bridgeGeneration: 1,
      revision: 4,
    },
    renderer: {
      bridgeGeneration: 1,
      stageFingerprint: 'stage-fingerprint',
      targetFingerprint: input.rendererFingerprint,
    },
    rasterFingerprint: input.rasterFingerprint,
    capture: {
      method: 'konva-mounted-node-to-canvas-v1',
      started: {
        schemaVersion: 1,
        documentId: `doc-${input.id}`,
        documentEpoch: 1,
        bridgeVersion: 7,
        bridgeGeneration: 1,
        revision: 3,
      },
      completed: {
        schemaVersion: 1,
        documentId: `doc-${input.id}`,
        documentEpoch: 1,
        bridgeVersion: 7,
        bridgeGeneration: 1,
        revision: 4,
      },
      rendererStable: true,
      boundsStable: true,
    },
    region: {
      coordinateSpace: 'stage-viewport-css',
      x: 10,
      y: 20,
      width: 40,
      height: 40,
      backingScaleX: 1,
      backingScaleY: 1,
    },
    rendered: {
      backingWidth,
      backingHeight,
      rgbaByteLength: backingWidth * backingHeight * 4,
      rgbaSha256: 'c'.repeat(64),
      nonTransparentPixelCount: 12,
    },
  };
}

function executionChild(
  executionRole: CrosswordExecutionRole,
  seed: number,
  overrides: Partial<Record<string, unknown>> = {},
) {
  const words = [...WORDS];
  const layoutSeed = (overrides.layoutSeed as number | undefined) ?? seed;
  const layout = generateCrosswordLayout(words, layoutSeed);
  const structural = crosswordSemanticPayloadFromLayerShape({ words, layout }, words);
  if (!structural.ok || structural.payload === null) throw new Error('fixture layout invalid');
  const semanticDigest = crosswordSemanticDigest(structural.payload);
  const createdTargetId = `cw-${executionRole}`;
  const documentId = `doc-${executionRole}`;
  const rasterFingerprint = `raster-${executionRole}`;
  const rendererFingerprint = `renderer-${executionRole}`;
  const { layoutSeed: _ignored, ...remaining } = overrides as Record<string, unknown>;
  const child = {
    schemaVersion: CROSSWORD_OBSERVATION_SCHEMA_VERSION,
    executionRole,
    clock: {
      providerId: WALL_CLOCK_PROVIDER_ID,
      namespace: WALL_CLOCK_NAMESPACE,
      baselineUtc: new Date(seed).toISOString(),
      expectedSeed: seed,
    },
    sourceContractFingerprint: SOURCE_FINGERPRINT,
    transition: {
      preActionHostCrosswordCount: 0,
      postActionHostCrosswordCount: 1,
      newTargetCount: 1,
      historyPastDepthBefore: 0,
      historyPastDepthAfter: 1,
    },
    currentness: {
      schemaVersion: 1,
      documentId,
      documentEpoch: 1,
      bridgeGeneration: 1,
      observationRevision: 4,
      actionEpochId: `epoch-${executionRole}`,
      hostLayoutId: 'layout-a',
      createdTargetId,
      generationSeed: seed,
      wordsFingerprint: crosswordWordsFingerprint(structural.payload.words),
      semanticLayoutDigest: semanticDigest,
      rendererFingerprint,
      rasterFingerprint,
    },
    actualSeed: seed,
    words,
    layout,
    semanticDigest,
    // Accepted live target geometry; the generated-vector raster region below
    // deliberately agrees with it within RENDER_TRANSFORM_CSS.
    targetGeometry: { id: createdTargetId, x: 10, y: 20, width: 40, height: 40 },
    raster: generatedVectorRaster({ id: createdTargetId, rendererFingerprint, rasterFingerprint }),
    observationId: `obs-${executionRole}`,
    tornRecaptureCount: 0,
    contextClosed: true,
    ...remaining,
  };
  return child;
}

function executionSet(seeds: readonly [number, number, number]) {
  return {
    clock: clock([
      new Date(seeds[0]).toISOString(),
      new Date(seeds[1]).toISOString(),
      new Date(seeds[2]).toISOString(),
    ]),
    sourceFingerprintExpected: SOURCE_FINGERPRINT,
    executions: [
      executionChild('A1', seeds[0]),
      executionChild('A2', seeds[1]),
      executionChild('B', seeds[2]),
    ],
  };
}

const CROSSWORD_CREATE_INTENT: CaseIntent = {
  subjectId: 'layer/crossword',
  capability: 'create',
  variant: null,
  scenario: 'create-crossword',
  preState: {},
  operations: [{ discriminant: 'create.generated', parameters: {} }],
  expected: {},
  resources: [],
};

/**
 * The compile-once crossword envelope for the same request the planning tests
 * use. The current public Crossword projection is assembled from this envelope's
 * compiled profile, the accepted Oracle evaluation, and the delivered live-fact
 * checks; the removed boolean `buildCrosswordGenerationProjection` has no current
 * counterpart.
 */
const CROSSWORD_ENVELOPE = (() => {
  const planning = planCaseForExecution(diagnosticRequest(CROSSWORD_CREATE_INTENT), {
    catalogues: defaultBundle(),
  });
  if (planning.status !== 'PLANNED') {
    throw new Error(`crossword case did not plan: ${planning.status}`);
  }
  if (planning.envelope === null) {
    throw new Error('crossword case compiled no materialization envelope');
  }
  return planning.envelope;
})();

const CROSSWORD_PROFILE = CROSSWORD_ENVELOPE.correctnessProfile;

/** The one Action Cycle the current record links every crossword check to. */
const CROSSWORD_ACTION_CYCLE: ActionCycleCorrectnessIdentity = {
  schemaVersion: CHECK_RESULT_CONTRACT_SCHEMA_VERSION,
  actionCycleId: 'wp5e-crossword-action-cycle',
  resolvedProfileFingerprint: CROSSWORD_PROFILE.resolvedFingerprint,
  readinessFingerprint: CROSSWORD_PROFILE.componentFingerprints.readiness,
};

/** The declared authoritative evidence roles, all observed as `authoritative`. */
function authoritativeCrosswordEvidence(): CrosswordEvidenceFact[] {
  return CROSSWORD_PROFILE.requiredAuthoritativeEvidence.map((evidenceId) => ({
    evidenceId,
    availability: 'authoritative' as const,
  }));
}

/**
 * Evaluates the delivered Crossword live-fact adapter/kernel over the accepted
 * Oracle evaluation. The returned three-state `CorrectnessCheckResult` values
 * are the strict-v4 checks the current record carries; no legacy boolean
 * `passed`/`harnessInvalid` authority is read.
 */
function finalCrosswordChecks(input: CrosswordOracleInput): readonly CorrectnessCheckResult[] {
  const evaluation = evaluateCrosswordOracle(input);
  const observation: CrosswordLiveEvaluationObservation = {
    primitiveFacts: evaluation.primitiveFacts,
    comparison: evaluation.comparison,
    diagnostics: evaluation.diagnostics,
  };
  const outcome = evaluateCrosswordLiveChecks({
    envelope: CROSSWORD_ENVELOPE,
    route: {
      subjectId: CROSSWORD_CREATE_INTENT.subjectId,
      capability: CROSSWORD_CREATE_INTENT.capability,
      variant: CROSSWORD_CREATE_INTENT.variant,
    },
    actionCycle: CROSSWORD_ACTION_CYCLE,
    clock: input.clock,
    sourceFingerprintExpected: input.sourceFingerprintExpected,
    executions: input.executions,
    oracle: observation,
    evidence: authoritativeCrosswordEvidence(),
  });
  if (!outcome.ok || outcome.result.ok !== true) {
    throw new Error('the current crossword live-fact kernel refused the accepted evaluation');
  }
  return outcome.result.checks;
}

/** Exact ordered word equality, mirroring the accepted comparison contract. */
function orderedWordsEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((word, index) => word === right[index]);
}

/**
 * Assembles the current strict-v4 `FinalCrosswordProjectionV4` from the accepted
 * three-child Oracle evaluation and the delivered live-fact checks, exactly as
 * the executor/final-façade pair do: the per-execution facts come from the
 * accepted children, the run-level comparison is equality-only, and the one
 * delivered check set is attached to every execution (ADR 0032 §E3-S2).
 *
 * The removed boolean projection published private currentness (document id and
 * observation revision) and a `seedExcludedFromSemanticDigest` marker; the
 * current projection carries neither. The private document is never projected,
 * and the projected semantic digest is the accepted payload digest, whose
 * preimage excludes the seed and runtime ids by construction.
 */
function finalCrosswordProjection(
  evaluation: CrosswordOracleEvaluation,
  checks: readonly CorrectnessCheckResult[],
): FinalCrosswordProjectionV4 | null {
  if (evaluation.comparison === null || evaluation.executions.length !== 3) return null;
  const byRole = new Map(
    evaluation.executions.map((child) => [child.executionRole, child] as const),
  );
  const a1 = byRole.get('A1');
  const a2 = byRole.get('A2');
  const b = byRole.get('B');
  if (a1 === undefined || a2 === undefined || b === undefined) return null;
  return {
    schemaVersion: FINAL_NESTED_PROJECTION_SCHEMA_VERSION,
    family: 'crossword',
    providerId: WALL_CLOCK_PROVIDER_ID,
    namespace: WALL_CLOCK_NAMESPACE,
    comparisonProfileId: CROSSWORD_COMPARISON_PROFILE_ID,
    executions: [a1, a2, b].map((child) => ({
      executionRole: child.executionRole,
      clockBaselineUtc: child.clock.baselineUtc,
      expectedSeed: child.clock.expectedSeed,
      actualSeed: child.actualSeed,
      hostLayoutId: child.currentness.hostLayoutId,
      createdTargetId: child.currentness.createdTargetId,
      words: [...child.words],
      semanticDigest: child.semanticDigest,
      actionCycleRef: CROSSWORD_ACTION_CYCLE.actionCycleId,
      checks,
    })),
    comparison: {
      sameSeedEqual: a1.actualSeed === a2.actualSeed,
      sameWordsEqual: orderedWordsEqual(a1.words, a2.words),
      sameSemanticDigestEqual: a1.semanticDigest === a2.semanticDigest,
      controlSeedDifferent: a1.actualSeed !== b.actualSeed,
      controlWordsEqual: orderedWordsEqual(a1.words, b.words),
      controlSemanticDigestDifferent: a1.semanticDigest !== b.semanticDigest,
    },
  };
}

const RELEASE_ROLES = [
  {
    role: 'host',
    kind: 'layout',
    layoutRole: 'active' as const,
    resolution: 'pre-action-existing' as const,
  },
  {
    role: 'created-target',
    kind: 'crossword',
    layoutRole: 'active' as const,
    resolution: 'post-action-new' as const,
    semanticProfile: CROSSWORD_SEMANTIC_PROFILE,
  },
];

const HOST_ELEMENTS: AdapterElementFact[] = [
  { id: 'layout-a', kind: 'layout', parentId: null, mounted: true },
  { id: 'layout-b', kind: 'layout', parentId: null, mounted: true },
  { id: 'text-a', kind: 'text', parentId: 'layout-a', mounted: true },
  { id: 'text-b', kind: 'text', parentId: 'layout-b', mounted: true },
];

describe('[WP5 Slice 5-E] generated-specialized@2 catalogue migration', () => {
  it('bumps the adapter catalogue and both generated Subject declarations to v2', () => {
    const bundle = loadCatalogueBundle();
    const entry = bundle.adapterCatalogue.adapters.find(
      (adapter) => adapter.adapterId === 'generated-specialized',
    );
    expect(entry?.compatibilityVersion).toBe(2);

    for (const subjectId of ['layer/crossword', 'layer/starmap']) {
      const declaration = bundle.subjectCatalogue.declarations.find(
        (candidate) => candidate.subjectId === subjectId,
      );
      expect(declaration?.adapter).toEqual({
        adapterId: GENERATED_SPECIALIZED_ADAPTER_ID,
        compatibilityVersion: GENERATED_SPECIALIZED_COMPATIBILITY_VERSION,
      });
    }

    const resolution = resolveAdapterImplementation({
      catalogue: bundle.adapterCatalogue,
      declaration: { adapterId: GENERATED_SPECIALIZED_ADAPTER_ID, compatibilityVersion: 2 },
    });
    expect(resolution.ok).toBe(true);
    expect(ADAPTER_IMPLEMENTATIONS['generated-specialized']).toBeDefined();
  });

  it('rejects a stale v1 declaration instead of negotiating the migration', () => {
    const bundle = loadCatalogueBundle();
    const resolution = resolveAdapterImplementation({
      catalogue: bundle.adapterCatalogue,
      declaration: { adapterId: GENERATED_SPECIALIZED_ADAPTER_ID, compatibilityVersion: 1 },
    });
    expect(resolution.ok).toBe(false);
    if (!resolution.ok) expect(resolution.finding.code).toBe('ADAPTER_IMPLEMENTATION_UNAVAILABLE');
  });

  it('routes the crossword create binding through crossword.create-default with the six checks', () => {
    const declaration = defaultBundle().subjectCatalogue.declarations.find(
      (candidate) => candidate.subjectId === 'layer/crossword',
    );
    const binding = declaration?.capabilityBindings.find(
      (candidate) => candidate.capability === 'create',
    );
    expect(binding?.workflowId).toBe('crossword.create-default');
    expect([...(binding?.checks ?? [])].sort()).toEqual([...CROSSWORD_REQUIRED_CHECKS].sort());
  });

  it('declares the exact native More → Crossword operations', () => {
    const bundle = loadCatalogueBundle();
    const steps = resolveWorkflowSteps(bundle.workflowStepCatalogue, 'crossword.create-default');
    expect(steps?.steps.map((step) => step.primitive)).toEqual([
      'control.activate',
      'control.activate',
    ]);
    expect(steps?.steps.map((step) => step.targetRole)).toEqual([
      'control:more',
      'control:crossword',
    ]);
  });

  it('resolves the corrected release fixture with explicit role timing and no Crossword constructor', () => {
    const bundle = loadCatalogueBundle();
    const fixture = resolveBindingFixture(bundle.fixtureCatalogue, {
      subjectId: 'layer/crossword',
      capability: 'create',
      scenarioId: 'create-crossword',
    });
    expect(fixture?.fixtureId).toBe('layer-crossword-create-deterministic-v1');
    expect(fixture?.constructorId).toBe('artwork.two-layout-text.v1');
    expect(fixture?.constructorVersion).toBe(1);
    expect(fixture?.semanticTargetRoles).toEqual(RELEASE_ROLES);

    const parsed = parseCrosswordClockProfile((fixture?.inputs as Record<string, unknown>).clock);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.clock.epochs).toEqual([...CROSSWORD_RELEASE_EPOCHS]);
      expect(parsed.clock.comparisonProfileId).toBe(CROSSWORD_COMPARISON_PROFILE_ID);
    }

    const collision = resolveBindingFixture(bundle.fixtureCatalogue, {
      subjectId: 'layer/crossword',
      capability: 'create',
      scenarioId: 'create-crossword-intentional-collision',
    });
    expect(collision?.constructorId).toBe('artwork.two-layout-text.v1');
    expect(collision?.semanticTargetRoles).toEqual(RELEASE_ROLES);
  });

  it('never declares the removed Crossword-bearing constructor anywhere', () => {
    const bundle = loadCatalogueBundle();
    for (const fixture of bundle.fixtureCatalogue.fixtures) {
      expect(fixture.constructorId).not.toBe('artwork.crossword-default.v1');
    }
  });

  it('requires an explicit resolution on every parsed role', () => {
    const bundle = loadCatalogueBundle();
    for (const fixture of bundle.fixtureCatalogue.fixtures) {
      for (const role of fixture.semanticTargetRoles) {
        expect(['pre-action-existing', 'post-action-new']).toContain(role.resolution);
      }
    }
  });
});

describe('[WP5 Slice 5-E] fixture catalogue v2 role timing', () => {
  it('defaults nothing: a missing or unknown resolution fails closed', async () => {
    const { parseBindingFixtureCatalogue, FixtureCatalogueError } = await import(
      '../../src/catalogue/fixtures'
    );
    const catalogue = loadCatalogueBundle().fixtureCatalogue;
    for (const [mutate, label] of [
      [
        (role: Record<string, unknown>) => {
          delete role.resolution;
        },
        'missing',
      ],
      [
        (role: Record<string, unknown>) => {
          role.resolution = 'sometime';
        },
        'unknown',
      ],
    ] as const) {
      const targeted = structuredClone(catalogue) as unknown as {
        fixtures: { fixtureId: string; semanticTargetRoles: Record<string, unknown>[] }[];
      };
      const fixture = targeted.fixtures.find(
        (entry) => entry.fixtureId === 'layer-text-move-drag-ordinary',
      );
      if (!fixture) throw new Error('fixture missing');
      mutate(fixture.semanticTargetRoles[0] as Record<string, unknown>);
      expect(() => parseBindingFixtureCatalogue(targeted), label).toThrow(FixtureCatalogueError);
    }
  });
});

describe('[WP5 Slice 5-E] phase-aware host-to-created-target resolution', () => {
  it('resolves only the host before action and never evaluates the created target', () => {
    const resolutions = generatedSpecializedAdapter().resolveTargets({
      phase: 'pre-action',
      roles: RELEASE_ROLES,
      elements: HOST_ELEMENTS,
      activeLayoutId: 'layout-a',
    });
    expect(resolutions.map((entry) => entry.role)).toEqual(['host']);
    expect(resolutions[0]?.status).toBe('resolved');
    expect(resolutions[0]?.target?.elementId).toBe('layout-a');
  });

  it('resolves exactly one new active-host target by exact set difference after action', () => {
    const pre = generatedSpecializedAdapter().resolveTargets({
      phase: 'pre-action',
      roles: RELEASE_ROLES,
      elements: HOST_ELEMENTS,
      activeLayoutId: 'layout-a',
    });
    const baseline = buildAdapterResolutionBaseline({
      resolutions: pre,
      elements: HOST_ELEMENTS,
      activeLayoutId: 'layout-a',
    });
    const post = generatedSpecializedAdapter().resolveTargets({
      phase: 'post-action',
      roles: RELEASE_ROLES,
      elements: [
        ...HOST_ELEMENTS,
        { id: 'cw-new', kind: 'crossword', parentId: 'layout-a', mounted: true },
      ],
      activeLayoutId: 'layout-a',
      baseline,
    });
    expect(post.map((entry) => entry.role)).toEqual(['created-target']);
    expect(post[0]?.status).toBe('resolved');
    expect(post[0]?.target?.elementId).toBe('cw-new');
    expect(post[0]?.target?.semanticProfile).toBe(CROSSWORD_SEMANTIC_PROFILE);
  });

  it('never guesses for zero, two, wrong-parent, control-layout, or unmounted additions', () => {
    const pre = generatedSpecializedAdapter().resolveTargets({
      phase: 'pre-action',
      roles: RELEASE_ROLES,
      elements: HOST_ELEMENTS,
      activeLayoutId: 'layout-a',
    });
    const baseline = buildAdapterResolutionBaseline({
      resolutions: pre,
      elements: HOST_ELEMENTS,
      activeLayoutId: 'layout-a',
    });
    const resolvePost = (elements: AdapterElementFact[]) =>
      generatedSpecializedAdapter().resolveTargets({
        phase: 'post-action',
        roles: RELEASE_ROLES,
        elements,
        activeLayoutId: 'layout-a',
        baseline,
      })[0];

    expect(resolvePost(HOST_ELEMENTS)?.status).toBe('unresolved');
    expect(
      resolvePost([
        ...HOST_ELEMENTS,
        { id: 'cw-1', kind: 'crossword', parentId: 'layout-a', mounted: true },
        { id: 'cw-2', kind: 'crossword', parentId: 'layout-a', mounted: true },
      ])?.status,
    ).toBe('ambiguous');
    // A new crossword in the control layout is never the created target.
    expect(
      resolvePost([
        ...HOST_ELEMENTS,
        { id: 'cw-control', kind: 'crossword', parentId: 'layout-b', mounted: true },
      ])?.status,
    ).toBe('unresolved');
    expect(
      resolvePost([
        ...HOST_ELEMENTS,
        { id: 'cw-hidden', kind: 'crossword', parentId: 'layout-a', mounted: true, hidden: true },
      ])?.status,
    ).toBe('unmounted');
    expect(
      resolvePost([
        ...HOST_ELEMENTS,
        { id: 'cw-unmounted', kind: 'crossword', parentId: 'layout-a', mounted: false },
      ])?.status,
    ).toBe('unmounted');
  });

  it('selects readiness from the declared contract before the created target exists', () => {
    const adapter = generatedSpecializedAdapter();
    const preResolutions = adapter.resolveTargets({
      phase: 'pre-action',
      roles: RELEASE_ROLES,
      elements: HOST_ELEMENTS,
      activeLayoutId: 'layout-a',
    });
    const pre = adapter.contributeReadiness({
      phase: 'pre-action',
      roles: RELEASE_ROLES,
      resolutions: preResolutions,
    });
    expect(pre.profileId).toBe(CROSSWORD_GENERATION_READINESS_PROFILE);
    expect(pre.targetIds).toEqual([]);
    expect(pre.targetAware).toBe(false);

    const post = adapter.contributeReadiness({
      phase: 'post-action',
      roles: RELEASE_ROLES,
      resolutions: [
        {
          role: 'created-target',
          status: 'resolved',
          matchCount: 1,
          matchedElementIds: ['cw-new'],
          target: {
            role: 'created-target',
            elementId: 'cw-new',
            kind: 'crossword',
            parentId: 'layout-a',
            semanticProfile: CROSSWORD_SEMANTIC_PROFILE,
          },
          detail: 'resolved',
        },
      ],
    });
    expect(post.targetIds).toEqual(['cw-new']);
    expect(post.targetAware).toBe(true);
  });

  it('applies the phase filter generically without a Subject branch', () => {
    expect(rolesForPhase(RELEASE_ROLES, 'pre-action').map((role) => role.role)).toEqual(['host']);
    expect(rolesForPhase(RELEASE_ROLES, 'post-action').map((role) => role.role)).toEqual([
      'created-target',
    ]);
  });

  it('adds the six required checks on the declared semantic profile', () => {
    const adapter = generatedSpecializedAdapter();
    const normalized = adapter.normalizeResult(
      [
        {
          role: 'created-target',
          status: 'resolved',
          matchCount: 1,
          matchedElementIds: ['cw-new'],
          target: {
            role: 'created-target',
            elementId: 'cw-new',
            kind: 'crossword',
            parentId: 'layout-a',
            semanticProfile: GENERATED_CROSSWORD_SEMANTIC_PROFILE,
          },
          detail: 'resolved',
        },
      ],
      'create',
      ['crossword.semantic-valid'],
    );
    expect(normalized.capability).toBe('create');
    expect([...normalized.requiredChecks].sort()).toEqual([...CROSSWORD_REQUIRED_CHECKS].sort());
  });

  it('does not require a hit point for a create host layout', () => {
    const problems = generatedSpecializedAdapter().validatePreconditions({
      resolutions: [
        {
          role: 'host',
          status: 'resolved',
          matchCount: 1,
          matchedElementIds: ['layout-a'],
          target: { role: 'host', elementId: 'layout-a', kind: 'layout', parentId: null },
          detail: 'resolved',
        },
      ],
      geometry: {
        'layout-a': {
          elementId: 'layout-a',
          mounted: true,
          visible: true,
          listening: true,
          hasHitPoint: false,
        },
      },
      pointerRoles: [],
    });
    expect(problems).toEqual([]);
  });
});

describe('[WP5 Slice 5-E] governed clock profile', () => {
  it('accepts the canonical same-seed/different-seed sequence', () => {
    const parsed = parseCrosswordClockProfile(clock([BASELINE_A, BASELINE_A, BASELINE_B]));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.clock.epochs).toEqual([SEED_A, SEED_A, SEED_B]);
      expect(parsed.clock.providerId).toBe(WALL_CLOCK_PROVIDER_ID);
    }
  });

  it('fails closed on every malformed or non-discriminating sequence', () => {
    const cases: unknown[] = [
      null,
      { ...clock([BASELINE_A, BASELINE_A, BASELINE_B]), schemaVersion: 2 },
      { ...clock([BASELINE_A, BASELINE_A, BASELINE_B]), profileId: 'other' },
      { ...clock([BASELINE_A, BASELINE_A, BASELINE_B]), providerId: 'fake' },
      { ...clock([BASELINE_A, BASELINE_A, BASELINE_B]), comparisonProfileId: 'other' },
      { ...clock([BASELINE_A, BASELINE_A, BASELINE_B]), baselines: [BASELINE_A, BASELINE_A] },
      {
        ...clock([BASELINE_A, BASELINE_A, BASELINE_B]),
        baselines: ['2026-01-02T03:04:05Z', BASELINE_A, BASELINE_B],
      },
      clock([BASELINE_A, BASELINE_B, BASELINE_B]),
      clock([BASELINE_A, BASELINE_A, BASELINE_A]),
    ];
    for (const value of cases) {
      const parsed = parseCrosswordClockProfile(value);
      expect(parsed.ok, JSON.stringify(value)).toBe(false);
      if (!parsed.ok) expect(parsed.finding.code).toBe('CROSSWORD_CLOCK_PROFILE_INVALID');
    }
  });
});

describe('[WP5 Slice 5-E] execution/currentness DTO validators', () => {
  it('accepts a well-formed child and recomputes its semantic digest', () => {
    const validation = validateCrosswordExecutionChild(executionChild('A1', SEED_A));
    expect(validation.ok).toBe(true);
    if (validation.ok) {
      expect(validation.child.semanticDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(validation.child.words).toEqual(WORDS);
      expect(validation.child.actualSeed).toBe(SEED_A);
      expect(crosswordWordsAreAuthoritative(validation.child)).toBe(true);
    }
  });

  it('rejects a malformed, wrong-role, or non-safe-seed child', () => {
    expect(validateCrosswordExecutionChild(null).ok).toBe(false);
    expect(
      (
        validateCrosswordExecutionChild({ ...executionChild('A1', SEED_A), schemaVersion: 9 }) as {
          finding: { code: string };
        }
      ).finding.code,
    ).toBe('CROSSWORD_OBSERVATION_MALFORMED');
    expect(
      (
        validateCrosswordExecutionChild({
          ...executionChild('A1', SEED_A),
          executionRole: 'ghost',
        }) as {
          finding: { code: string };
        }
      ).finding.code,
    ).toBe('CROSSWORD_OBSERVATION_ROLE_UNKNOWN');
    expect(
      (
        validateCrosswordExecutionChild({
          ...executionChild('A1', SEED_A),
          actualSeed: 1.5,
        }) as { finding: { code: string } }
      ).finding.code,
    ).toBe('CROSSWORD_CURRENTNESS_INVALID');
    expect(
      (
        validateCrosswordExecutionChild({
          ...executionChild('A1', SEED_A),
          sourceContractFingerprint: 'not-a-digest',
        }) as { finding: { code: string } }
      ).finding.code,
    ).toBe('CROSSWORD_SOURCE_FINGERPRINT_INVALID');
  });

  it('rejects missing/wrong-target/torn generated-vector raster authority', () => {
    const child = executionChild('A1', SEED_A);
    expect(
      (
        validateCrosswordExecutionChild({ ...child, raster: null }) as {
          finding: { code: string };
        }
      ).finding.code,
    ).toBe('CROSSWORD_RASTER_AUTHORITY_UNUSABLE');
    expect(
      (
        validateCrosswordExecutionChild({
          ...child,
          raster: { ...(child.raster as unknown as Record<string, unknown>), id: 'other-target' },
        }) as { finding: { code: string } }
      ).finding.code,
    ).toBe('CROSSWORD_RASTER_AUTHORITY_UNUSABLE');
    expect(
      (
        validateCrosswordExecutionChild({
          ...child,
          raster: {
            ...(child.raster as unknown as Record<string, unknown>),
            status: 'torn',
            reason: 'torn',
          },
        }) as { finding: { code: string } }
      ).finding.code,
    ).toBe('CROSSWORD_RASTER_AUTHORITY_UNUSABLE');
  });

  it('refuses to normalize a malformed generated layout into passing evidence', () => {
    const child = executionChild('A1', SEED_A);
    const layout = child.layout as unknown as Record<string, unknown>;
    const broken = { ...child, layout: { ...layout, cells: [] } };
    const validation = validateCrosswordExecutionChild(broken);
    expect(validation.ok).toBe(false);
    if (!validation.ok) expect(validation.finding.code).toBe('CROSSWORD_SEMANTIC_MALFORMED');
  });

  it('requires a causal 0 → 1 transition and completed context closure', () => {
    const child = executionChild('A1', SEED_A);
    expect(
      (
        validateCrosswordExecutionChild({
          ...child,
          transition: { ...child.transition, postActionHostCrosswordCount: 0 },
        }) as { finding: { code: string } }
      ).finding.code,
    ).toBe('CROSSWORD_OBSERVATION_MALFORMED');
    expect(
      (
        validateCrosswordExecutionChild({ ...child, contextClosed: false }) as {
          finding: { code: string };
        }
      ).finding.code,
    ).toBe('CROSSWORD_OBSERVATION_MALFORMED');
  });

  it('classifies missing, duplicate, reused-document children without credit leakage', () => {
    const valid = executionSet([SEED_A, SEED_A, SEED_B]);

    const missing = validateCrosswordExecutionSet({
      ...valid,
      executions: valid.executions.slice(0, 2),
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok)
      expect(missing.findings.map((f) => f.code)).toContain('CROSSWORD_OBSERVATION_MISSING');

    const duplicateRole = validateCrosswordExecutionSet({
      ...valid,
      executions: [valid.executions[0], valid.executions[0], valid.executions[2]],
    });
    expect(duplicateRole.ok).toBe(false);
    if (!duplicateRole.ok)
      expect(duplicateRole.findings.map((f) => f.code)).toContain(
        'CROSSWORD_OBSERVATION_DUPLICATE',
      );

    const reusedDocument = executionSet([SEED_A, SEED_A, SEED_B]);
    (
      reusedDocument.executions[1] as { currentness: { documentId: string } }
    ).currentness.documentId = 'doc-A1';
    const validated = validateCrosswordExecutionSet(reusedDocument);
    expect(validated.ok).toBe(false);
    if (!validated.ok)
      expect(validated.findings.map((f) => f.code)).toContain('CROSSWORD_OBSERVATION_DUPLICATE');
  });
});

describe('[WP5 Slice 5-E] crossword-determinism-v1 Oracle (six checks)', () => {
  function outcome(evaluation: ReturnType<typeof evaluateCrosswordOracle>) {
    return classifyOutcome({
      requiredChecks: evaluation.checks,
      cleanupSucceeded: true,
      requiredSourcesAgree: evaluation.requiredSourcesAgree,
      harnessInvalid: evaluation.harnessInvalid,
      environmentInvalid: false,
    });
  }

  it('passes all six checks for reproducible same-seed and sensitive different-seed executions', () => {
    const evaluation = evaluateCrosswordOracle(executionSet([SEED_A, SEED_A, SEED_B]));
    expect(evaluation.harnessInvalid).toBe(false);
    expect(evaluation.checks).toHaveLength(6);
    expect(evaluation.checks.map((check) => check.checkId).sort()).toEqual(
      [...CROSSWORD_REQUIRED_CHECKS].sort(),
    );
    expect(evaluation.checks.every((check) => check.passed)).toBe(true);
    expect(evaluation.comparison?.repeatIdentical).toBe(true);
    expect(evaluation.comparison?.seedSensitivity).toBe(true);
    expect(outcome(evaluation)).toBe('PASS');
  });

  it('classifies the documented 2 ms collision as a product BUG, never a PASS', () => {
    const colliding = executionSet([SEED_A, SEED_A, SEED_COLLISION]);
    const evaluation = evaluateCrosswordOracle(colliding);
    expect(evaluation.harnessInvalid).toBe(false);
    expect(
      evaluation.checks.find((check) => check.checkId === 'crossword.different-seed-sensitive')
        ?.passed,
    ).toBe(false);
    expect(evaluation.diagnostics.map((entry) => entry.code)).toContain(
      'PRODUCT_CROSSWORD_SEED_INSENSITIVE',
    );
    expect(outcome(evaluation)).toBe('BUG');
  });

  it('classifies a same-seed digest mismatch as a product BUG', () => {
    const seeded = executionSet([SEED_A, SEED_A, SEED_B]);
    // A2 declares the same-seed clock baseline but a genuinely different layout.
    (seeded.executions as unknown[])[1] = executionChild('A2', SEED_A, { layoutSeed: SEED_B });
    const evaluation = evaluateCrosswordOracle(seeded);
    expect(evaluation.harnessInvalid).toBe(false);
    expect(
      evaluation.checks.find((check) => check.checkId === 'crossword.same-seed-repeatable')?.passed,
    ).toBe(false);
    expect(evaluation.diagnostics.map((entry) => entry.code)).toContain(
      'PRODUCT_CROSSWORD_REPEAT_MISMATCH',
    );
    expect(outcome(evaluation)).toBe('BUG');
  });

  it('treats accepted source drift as unusable authority', () => {
    const drifted = executionSet([SEED_A, SEED_A, SEED_B]);
    drifted.sourceFingerprintExpected = 'f'.repeat(64);
    const evaluation = evaluateCrosswordOracle(drifted);
    expect(evaluation.harnessInvalid).toBe(true);
    expect(evaluation.diagnostics.map((entry) => entry.code)).toContain('CROSSWORD_SOURCE_DRIFT');
    expect(outcome(evaluation)).toBe('HARNESS_BLOCKED');
  });

  it('treats a malformed layout as unusable evidence rather than a product defect', () => {
    const malformed = executionSet([SEED_A, SEED_A, SEED_B]);
    const layout = (malformed.executions[0] as Record<string, unknown>).layout as Record<
      string,
      unknown
    >;
    (malformed.executions[0] as Record<string, unknown>).layout = { ...layout, cells: [] };
    const evaluation = evaluateCrosswordOracle(malformed);
    expect(evaluation.harnessInvalid).toBe(true);
    expect(evaluation.diagnostics.map((entry) => entry.code)).toContain(
      'CROSSWORD_SEMANTIC_MALFORMED',
    );
    expect(evaluation.checks.every((check) => !check.passed)).toBe(true);
    expect(outcome(evaluation)).toBe('HARNESS_BLOCKED');
  });

  it('treats an invalid clock as unusable evidence and blocks', () => {
    const invalid = executionSet([SEED_A, SEED_A, SEED_B]);
    invalid.clock = clock([BASELINE_A, BASELINE_A, BASELINE_A]);
    const evaluation = evaluateCrosswordOracle(invalid);
    expect(evaluation.harnessInvalid).toBe(true);
    expect(evaluation.diagnostics.map((entry) => entry.code)).toContain(
      'CROSSWORD_CLOCK_PROFILE_INVALID',
    );
  });

  it('keeps both Crossword product-mismatch codes as warnings that never block', () => {
    // Severity answers "is the harness authority unusable?", not "did the run
    // pass?": a trustworthy product mismatch stays a warning and the run is BUG.
    expect(DIAGNOSTIC_SEVERITY.PRODUCT_CROSSWORD_SEED_MISMATCH).toBe('warning');
    expect(DIAGNOSTIC_SEVERITY.PRODUCT_CROSSWORD_RASTER_INVALID).toBe('warning');
  });

  it('emits the seed warning only for a current, structurally valid seed mismatch', () => {
    const set = executionSet([SEED_A, SEED_A, SEED_B]);
    const first = set.executions[0] as (typeof set.executions)[number];
    (set.executions as unknown[])[0] = {
      ...first,
      actualSeed: SEED_B,
      currentness: { ...first.currentness, generationSeed: SEED_B },
    };
    const evaluation = evaluateCrosswordOracle(set);
    expect(evaluation.harnessInvalid).toBe(false);
    expect(
      evaluation.checks.find((check) => check.checkId === 'crossword.seed-derived')?.passed,
    ).toBe(false);
    expect(evaluation.diagnostics.map((entry) => entry.code)).toContain(
      'PRODUCT_CROSSWORD_SEED_MISMATCH',
    );
    expect(
      evaluation.diagnostics
        .filter((entry) => entry.code === 'PRODUCT_CROSSWORD_SEED_MISMATCH')
        .every((entry) => entry.severity === 'warning'),
    ).toBe(true);
    expect(outcome(evaluation)).toBe('BUG');
  });

  it('emits the raster warning only for interpretable exact-target raster authority', () => {
    const set = executionSet([SEED_A, SEED_A, SEED_B]);
    const first = set.executions[0] as (typeof set.executions)[number];
    (set.executions as unknown[])[0] = {
      ...first,
      raster: {
        ...first.raster,
        region:
          first.raster.region === null
            ? null
            : { ...first.raster.region, x: first.raster.region.x + 30 },
      },
    };
    const evaluation = evaluateCrosswordOracle(set);
    expect(evaluation.harnessInvalid).toBe(false);
    expect(
      evaluation.checks.find((check) => check.checkId === 'crossword.raster-current')?.passed,
    ).toBe(false);
    expect(evaluation.diagnostics.map((entry) => entry.code)).toContain(
      'PRODUCT_CROSSWORD_RASTER_INVALID',
    );
    expect(
      evaluation.diagnostics
        .filter((entry) => entry.code === 'PRODUCT_CROSSWORD_RASTER_INVALID')
        .every((entry) => entry.severity === 'warning'),
    ).toBe(true);
    expect(outcome(evaluation)).toBe('BUG');
  });

  it('never converts unusable raster authority into the product warning', () => {
    const set = executionSet([SEED_A, SEED_A, SEED_B]);
    const first = set.executions[0] as (typeof set.executions)[number];
    (set.executions as unknown[])[0] = { ...first, raster: { ...first.raster, status: 'torn' } };
    const evaluation = evaluateCrosswordOracle(set);
    const codes = evaluation.diagnostics.map((entry) => entry.code);
    expect(evaluation.harnessInvalid).toBe(true);
    expect(codes).toContain('CROSSWORD_RASTER_AUTHORITY_UNUSABLE');
    expect(codes).not.toContain('PRODUCT_CROSSWORD_RASTER_INVALID');
    expect(codes).not.toContain('PRODUCT_CROSSWORD_SEED_MISMATCH');
    expect(evaluation.checks.every((check) => !check.passed)).toBe(true);
    expect(outcome(evaluation)).toBe('HARNESS_BLOCKED');
  });

  it('keeps the comparison contract pure and equality-only', () => {
    const comparison = compareCrosswordExecutions({
      a1: { words: WORDS, seed: SEED_A, semanticDigest: 'a'.repeat(64) },
      a2: { words: WORDS, seed: SEED_A, semanticDigest: 'a'.repeat(64) },
      b: { words: WORDS, seed: SEED_B, semanticDigest: 'b'.repeat(64) },
    });
    expect(comparison).toEqual({
      wordsEqualAcrossChildren: true,
      sameSeedPair: true,
      differentSeedPair: true,
      repeatIdentical: true,
      seedSensitivity: true,
      seeds: { A1: SEED_A, A2: SEED_A, B: SEED_B },
      semanticDigests: {
        A1: 'a'.repeat(64),
        A2: 'a'.repeat(64),
        B: 'b'.repeat(64),
      },
    });
  });
});

describe('[WP5 Slice 5-E] profiles and the frozen engine boundary', () => {
  it('registers the exact ADR readiness/capture/Oracle profiles as data', () => {
    const readiness = resolveReadinessProfile(CROSSWORD_GENERATION_READINESS_PROFILE);
    expect(readiness?.captureProfileId).toBe(CROSSWORD_GENERATION_CAPTURE_PROFILE_ID);
    expect(readiness?.oracleProfileId).toBe(CROSSWORD_ORACLE_PROFILE_ID);
    expect(readiness?.requiresCrosswordSet).toBe(true);
    expect(readiness?.comparisonProfileId).toBe(CROSSWORD_COMPARISON_PROFILE_ID);
    expect(readiness?.requiresNestedPair).toBe(false);
    expect(readiness?.profile.profileId).toBe('crossword-generation-action-cycle-v1');
    expect(readiness?.profile.timingCategory).toBe('DERIVED_GENERATION_V1');
    expect(readiness?.profile.deadlineMs).toBe(8000);
    expect(readiness?.profile.signalWatchdogMs).toBe(100);
    expect(readiness?.profile.fallbackCadenceMs).toEqual([100, 200, 250]);
    expect(readiness?.profile.stableFrames).toBe(3);

    const oracle = resolveOracleProfile(CROSSWORD_ORACLE_PROFILE_ID);
    expect(oracle?.kind).toBe('crossword-determinism');
    expect(oracle?.version).toBe(1);
  });

  it('executes the exact native More → Crossword controls declaratively', async () => {
    const bundle = loadCatalogueBundle();
    const steps = resolveWorkflowSteps(bundle.workflowStepCatalogue, 'crossword.create-default');
    if (!steps) throw new Error('crossword.create-default steps are missing');

    const activated: string[] = [];
    const result = await executeWorkflowSteps({
      steps: steps.steps,
      operation: { discriminant: 'create.generated', parameters: {} },
      resolutions: [],
      points: {},
      handlers: {
        pointerDrag: async () => ({ ok: false, detail: 'unused' }),
        pointerClick: async () => ({ ok: false, detail: 'unused' }),
        controlActivate: async (request) => {
          activated.push(request.control);
          return { ok: true, detail: `activated ${request.control}` };
        },
        keyboardPress: async () => ({ ok: false, detail: 'unused' }),
        fileInputSet: async () => ({ ok: false, detail: 'unused' }),
      },
    });
    expect(result.ok).toBe(true);
    expect(activated).toEqual(['More', 'Crossword']);
  });
});

describe('[WP5 Slice 5-E] planner launchability and execution-support boundary', () => {
  it('plans the crossword binding as fully launchable through the delivered contracts', () => {
    const result = planned(planCase(diagnosticRequest(CROSSWORD_CREATE_INTENT)));
    expect(result.plan.route.adapterId).toBe(GENERATED_SPECIALIZED_ADAPTER_ID);
    expect(result.plan.route.adapterCompatibilityVersion).toBe(2);
    expect(result.plan.route.workflowId).toBe('crossword.create-default');
    expect([...result.plan.requiredChecks].sort()).toEqual([...CROSSWORD_REQUIRED_CHECKS].sort());
    expect(result.materializedCase.fixture?.targetRoleContractFingerprint).toMatch(
      /^[0-9a-f]{64}$/,
    );
    expect(result.materializedCase.fixture?.semanticTargetRoles).toEqual(RELEASE_ROLES);
    expect(deriveLaunchability(result.outputs.preflightReport).launchable).toBe(true);
  });

  it('moves materialization when only role timing changes but keeps case meaning', () => {
    const base = planned(planCase(diagnosticRequest(CROSSWORD_CREATE_INTENT)));
    const bundle = defaultBundle();
    const fixtureCatalogue = structuredClone(bundle.fixtureCatalogue);
    const fixture = fixtureCatalogue.fixtures.find(
      (entry) => entry.fixtureId === 'layer-crossword-create-deterministic-v1',
    );
    if (!fixture) throw new Error('crossword fixture missing');
    fixture.semanticTargetRoles = [
      { ...fixture.semanticTargetRoles[0], role: 'host-renamed' } as never,
      fixture.semanticTargetRoles[1] as never,
    ];
    const mutated = planned(
      planCase(diagnosticRequest(CROSSWORD_CREATE_INTENT), {
        catalogues: { ...bundle, fixtureCatalogue },
      }),
    );
    expect(mutated.materializedCase.fixture?.targetRoleContractFingerprint).not.toBe(
      base.materializedCase.fixture?.targetRoleContractFingerprint,
    );
    expect(mutated.materializationFingerprint).not.toBe(base.materializationFingerprint);
    expect(mutated.planFingerprint).not.toBe(base.planFingerprint);
    expect(mutated.caseId).toBe(base.caseId);
  });

  it('plans the diagnostic-only intentional-collision scenario without claiming Release credit', () => {
    const result = planned(
      planCase(
        diagnosticRequest({
          ...CROSSWORD_CREATE_INTENT,
          scenario: 'create-crossword-intentional-collision',
        }),
      ),
    );
    expect(deriveLaunchability(result.outputs.preflightReport).launchable).toBe(true);
    expect(result.outputs.coverageAttribution.releaseCreditEligible).toBe(false);
    expect(result.outputs.coverageAttribution.releaseCreditBlockers).toContain(
      'scenario-not-release-required',
    );
  });

  it('stays non-launchable when the crossword fixture is absent (no fallback)', () => {
    const bundle = defaultBundle();
    const fixtureCatalogue = structuredClone(bundle.fixtureCatalogue);
    fixtureCatalogue.fixtures = fixtureCatalogue.fixtures.filter(
      (fixture) => fixture.subjectId !== 'layer/crossword',
    );
    const result = planned(
      planCase(diagnosticRequest(CROSSWORD_CREATE_INTENT), {
        catalogues: { ...bundle, fixtureCatalogue },
      }),
    );
    const launchability = deriveLaunchability(result.outputs.preflightReport);
    expect(launchability.launchable).toBe(false);
    expect(launchability.deferredStages).toEqual(['P5', 'P7']);
  });

  it('resolves execution support from the delivered adapter registry', () => {
    // The generated adapter is delivered together with the corrected
    // profile-routed runtime, public writer, and cleanup proof.
    expect(resolveExecutionSupport('generated-specialized').supported).toBe(true);
    expect(resolveExecutionSupport('text-specialized').supported).toBe(true);
    expect(resolveExecutionSupport('image-specialized').supported).toBe(true);
    expect(resolveExecutionSupport('object-specialized').supported).toBe(true);
  });

  it('selects the sequential drive by closed role timing, never by Subject', () => {
    const bundle = loadCatalogueBundle();
    const crosswordHost = resolveFixture(bundle.fixtureCatalogue, {
      subjectId: 'layer/crossword',
      capability: 'create',
      scenarioId: 'create-crossword',
    });
    const textHost = resolveFixture(bundle.fixtureCatalogue, {
      subjectId: 'layer/text',
      capability: 'move',
      scenarioId: 'drag-ordinary',
    });
    expect(crosswordHost).not.toBeNull();
    expect(textHost).not.toBeNull();
    if (crosswordHost === null || textHost === null) return;
    expect(fixtureHasPostActionRoles(crosswordHost)).toBe(true);
    expect(fixtureHasPostActionRoles(textHost)).toBe(false);
  });
});

describe('[WP5 Slice 5-E] strict-v4 public Crossword projection (CR10)', () => {
  it('exposes three ordered executions, fixed identities, and run-level comparison', () => {
    const input = executionSet([SEED_A, SEED_A, SEED_B]);
    const evaluation = evaluateCrosswordOracle(input);
    const projection = finalCrosswordProjection(evaluation, finalCrosswordChecks(input));
    expect(projection).not.toBeNull();
    if (projection === null) return;
    expect(projection.schemaVersion).toBe(4);
    expect(projection.family).toBe('crossword');
    expect(projection.executions.map((entry) => entry.executionRole)).toEqual(['A1', 'A2', 'B']);
    expect(projection.executions.map((entry) => entry.expectedSeed)).toEqual([
      SEED_A,
      SEED_A,
      SEED_B,
    ]);
    expect(projection.executions.map((entry) => entry.createdTargetId)).toEqual([
      'cw-A1',
      'cw-A2',
      'cw-B',
    ]);
    expect(projection.comparison).toEqual({
      sameSeedEqual: true,
      sameWordsEqual: true,
      sameSemanticDigestEqual: true,
      controlSeedDifferent: true,
      controlWordsEqual: true,
      controlSemanticDigestDifferent: true,
    });
    // Seed exclusion is structural in the current contract: the projected
    // semantic digest is recomputed from the accepted payload, whose preimage
    // excludes the seed and runtime ids by construction.
    for (const child of evaluation.executions) {
      expect(child.semanticDigest).toBe(crosswordSemanticDigest(child.semantic));
    }
    // Every execution carries the one delivered strict-v4 check set, bound to
    // the single Action Cycle; no legacy boolean authority is published.
    for (const execution of projection.executions) {
      expect(execution.actionCycleRef).toBe(CROSSWORD_ACTION_CYCLE.actionCycleId);
      expect(execution.checks.map((check) => check.checkId)).toEqual(
        finalCrosswordChecks(input).map((check) => check.checkId),
      );
      expect(execution.checks.every((check) => check.status === 'PASS')).toBe(true);
    }
    // The projection must be guard-safe when serialized.
    expect(() => serializePublicRecord(projection)).not.toThrow();
  });

  it('never publishes private currentness even when the raw child carries it', () => {
    const input = executionSet([SEED_A, SEED_A, SEED_B]);
    const hostile = structuredClone(input) as unknown as {
      executions: { currentness: { documentId: string } }[];
    };
    const first = hostile.executions[0];
    if (first === undefined) throw new Error('unreachable');
    first.currentness.documentId = '/Users/private/secret-document';
    const evaluation = evaluateCrosswordOracle(hostile as unknown as CrosswordOracleInput);
    const projection = finalCrosswordProjection(
      evaluation,
      finalCrosswordChecks(hostile as unknown as CrosswordOracleInput),
    );
    expect(projection).not.toBeNull();
    if (projection === null) return;
    // The strict-v4 projection carries no private document authority: the raw
    // field is dropped, never published.
    const serialized = serializePublicRecord(projection);
    expect(serialized).not.toContain('secret-document');
    expect(serialized).not.toContain('/Users/');
    // The guard still refuses any candidate that reaches it carrying the field.
    const leaked = {
      ...projection,
      executions: projection.executions.map((entry, index) =>
        index === 0 ? { ...entry, hostLayoutId: '/Users/private/secret-document' } : entry,
      ),
    };
    let rejected: unknown;
    try {
      serializePublicRecord(leaked);
    } catch (error) {
      rejected = error;
    }
    expect(isRedactionRejected(rejected)).toBe(true);
  });
});

describe('[WP5 Slice 5-E] source-fingerprint drift detection', () => {
  it('binds the accepted product source and reports a changed source as drift', () => {
    const accepted = validateCrosswordSourceContract({
      storeSource: STORE_SOURCE,
      generatorSource: GENERATOR_SOURCE,
    });
    expect(accepted.ok).toBe(true);
    expect(accepted.fingerprint).toBe(SOURCE_FINGERPRINT);

    const drifted = validateCrosswordSourceContract({
      storeSource: STORE_SOURCE.replace('Date.now()', 'performance.now()'),
      generatorSource: GENERATOR_SOURCE,
    });
    expect(drifted.ok).toBe(false);
    expect(drifted.findings.map((finding) => finding.code)).toContain(
      'CROSSWORD_SOURCE_CONTRACT_CHANGED',
    );
  });

  it('rejects an execution carrying a stale source fingerprint as unusable authority', () => {
    const drift = executionSet([SEED_A, SEED_A, SEED_B]);
    drift.sourceFingerprintExpected = 'b'.repeat(64);
    const evaluation = evaluateCrosswordOracle(drift);
    expect(evaluation.harnessInvalid).toBe(true);
    expect(evaluation.diagnostics.map((entry) => entry.code)).toContain('CROSSWORD_SOURCE_DRIFT');
  });
});

// ── Final remediation findings 1–7 (focused mutation/deadline/torn/evidence) ──
// These tests pin the exact behaviors the final independent review rejected:
// immutable materialized source binding, full coherent capture, one bounded
// deadline, raster geometry agreement, check-specific evidence mapping,
// materialized collision seeds, and observed target-aware idle facts.

describe('[WP5 Slice 5-E] remediation — materialized source-contract binding', () => {
  it('binds the accepted source fingerprint into materialized and plan identity', () => {
    const result = planned(planCase(diagnosticRequest(CROSSWORD_CREATE_INTENT)));
    expect(result.materializedCase.fixture?.crosswordSourceFingerprint).toBe(SOURCE_FINGERPRINT);
    expect(result.plan.fixture?.crosswordSourceFingerprint).toBe(SOURCE_FINGERPRINT);

    const mutatedMaterialization = structuredClone(result.materializedCase);
    if (mutatedMaterialization.fixture === undefined) throw new Error('fixture missing');
    mutatedMaterialization.fixture.crosswordSourceFingerprint = 'a'.repeat(64);
    expect(deriveMaterializationFingerprint(mutatedMaterialization)).not.toBe(
      result.materializationFingerprint,
    );

    const mutatedPlan = structuredClone(result.plan);
    if (mutatedPlan.fixture === undefined) throw new Error('fixture missing');
    mutatedPlan.fixture.crosswordSourceFingerprint = 'a'.repeat(64);
    expect(derivePlanFingerprint(mutatedPlan)).not.toBe(result.planFingerprint);
  });

  it('fails closed when the live source no longer matches the materialized fingerprint', async () => {
    const result = planned(planCase(diagnosticRequest(CROSSWORD_CREATE_INTENT)));
    const driftedPlan = structuredClone(result.plan);
    if (driftedPlan.fixture === undefined) throw new Error('fixture missing');
    driftedPlan.fixture.crosswordSourceFingerprint = 'a'.repeat(64);
    const execution = await executeCrosswordPlan({
      allocation: { runId: 'unit-drift' },
      caseId: result.caseId,
      intent: result.materializedCase.intent,
      plan: driftedPlan,
      adapter: generatedSpecializedAdapter(),
      fixture: { inputs: {} },
      workflowSteps: [],
      environment: {},
    } as unknown as Parameters<typeof executeCrosswordPlan>[0]);
    expect(execution.crossword.outcome).toBe('HARNESS_BLOCKED');
    expect(execution.behavior.diagnostics.map((entry) => entry.code)).toContain(
      'CROSSWORD_SOURCE_DRIFT',
    );
    expect(execution.behavior.outcome).toBe('HARNESS_BLOCKED');
  });

  it('fails closed when the materialized plan binds no source fingerprint', async () => {
    const result = planned(planCase(diagnosticRequest(CROSSWORD_CREATE_INTENT)));
    const unbound = structuredClone(result.plan);
    if (unbound.fixture === undefined) throw new Error('fixture missing');
    delete unbound.fixture.crosswordSourceFingerprint;
    const execution = await executeCrosswordPlan({
      allocation: { runId: 'unit-unbound' },
      caseId: result.caseId,
      intent: result.materializedCase.intent,
      plan: unbound,
      adapter: generatedSpecializedAdapter(),
      fixture: { inputs: {} },
      workflowSteps: [],
      environment: {},
    } as unknown as Parameters<typeof executeCrosswordPlan>[0]);
    expect(execution.crossword.outcome).toBe('HARNESS_BLOCKED');
    expect(execution.behavior.diagnostics.map((entry) => entry.code)).toContain(
      'CROSSWORD_SOURCE_FINGERPRINT_INVALID',
    );
  });
});

describe('[WP5 Slice 5-E] remediation — check-specific Oracle evidence mapping', () => {
  it('maps each required check to the exact children/ids it consumed', () => {
    const evaluation = evaluateCrosswordOracle(executionSet([SEED_A, SEED_A, SEED_B]));
    expect(evaluation.evidence['crossword.created']).toEqual([
      'observation:obs-A1',
      'observation:obs-A2',
      'observation:obs-B',
    ]);
    expect(evaluation.evidence['crossword.seed-derived']).toEqual([
      'observation:obs-A1',
      'observation:obs-A2',
      'observation:obs-B',
    ]);
    expect(evaluation.evidence['crossword.same-seed-repeatable']).toEqual([
      'observation:obs-A1',
      'observation:obs-A2',
    ]);
    expect(evaluation.evidence['crossword.different-seed-sensitive']).toEqual([
      'observation:obs-A1',
      'observation:obs-B',
    ]);
    for (const child of evaluation.executions) {
      expect(evaluation.evidence['crossword.semantic-valid']).toContain(
        `semantic:${child.semanticDigest}`,
      );
      expect(evaluation.evidence['crossword.raster-current']).toContain(
        `raster:${child.raster.rasterFingerprint}`,
      );
    }
  });

  it('publishes empty evidence for an unusable evaluation, never a substitute', () => {
    const malformed = executionSet([SEED_A, SEED_A, SEED_B]);
    const layout = (malformed.executions[0] as Record<string, unknown>).layout as Record<
      string,
      unknown
    >;
    (malformed.executions[0] as Record<string, unknown>).layout = { ...layout, cells: [] };
    const evaluation = evaluateCrosswordOracle(malformed);
    expect(evaluation.harnessInvalid).toBe(true);
    expect(evaluation.evidence['crossword.created']).toEqual([]);
    expect(evaluation.evidence['crossword.raster-current']).toEqual([]);
  });
});

describe('[WP5 Slice 5-E] remediation — materialized collision clock profile', () => {
  it('passes seed-derived from the materialized profile and fails only sensitivity', () => {
    const input = executionSet([SEED_A, SEED_A, SEED_COLLISION]);
    const evaluation = evaluateCrosswordOracle(input);
    expect(
      evaluation.checks.find((check) => check.checkId === 'crossword.seed-derived')?.passed,
    ).toBe(true);
    expect(
      evaluation.checks.find((check) => check.checkId === 'crossword.different-seed-sensitive')
        ?.passed,
    ).toBe(false);
    expect(evaluation.checks.find((check) => check.checkId === 'crossword.created')?.passed).toBe(
      true,
    );
    expect(outcomeOf(evaluation)).toBe('BUG');

    const projection = finalCrosswordProjection(evaluation, finalCrosswordChecks(input));
    expect(projection).not.toBeNull();
    const b = projection?.executions.find((entry) => entry.executionRole === 'B');
    expect(b?.checks.find((check) => check.checkId === 'crossword.seed-derived')?.status).toBe(
      'PASS',
    );
    expect(
      b?.checks.find((check) => check.checkId === 'crossword.different-seed-sensitive')?.status,
    ).toBe('FAIL');
  });
});

describe('[WP5 Slice 5-E] remediation — raster region/target geometry agreement', () => {
  const region = {
    coordinateSpace: 'stage-viewport-css' as const,
    x: 10,
    y: 20,
    width: 40,
    height: 40,
    backingScaleX: 1,
    backingScaleY: 1,
  };

  it('accepts agreement within 0.25 CSS px and rejects a larger deviation', () => {
    expect(
      rasterRegionAgreesWithTarget({ region, target: { x: 10, y: 20, width: 40, height: 40 } })
        .agrees,
    ).toBe(true);
    expect(
      rasterRegionAgreesWithTarget({ region, target: { x: 10.2, y: 20, width: 40, height: 40 } })
        .agrees,
    ).toBe(true);
    const drift = rasterRegionAgreesWithTarget({
      region,
      target: { x: 10.3, y: 20, width: 40, height: 40 },
    });
    expect(drift.agrees).toBe(false);
    expect(drift.maxDeviationCssPx).toBeGreaterThan(0.25);
  });

  it('fails crossword.raster-current on a geometrically inconsistent projection', () => {
    const set = executionSet([SEED_A, SEED_A, SEED_B]);
    const child = set.executions[0] as { targetGeometry: { x: number } };
    child.targetGeometry = { ...child.targetGeometry, x: child.targetGeometry.x + 5 };
    const evaluation = evaluateCrosswordOracle(set);
    expect(evaluation.harnessInvalid).toBe(false);
    expect(
      evaluation.checks.find((check) => check.checkId === 'crossword.raster-current')?.passed,
    ).toBe(false);
    expect(outcomeOf(evaluation)).toBe('BUG');
  });

  it('rejects a target geometry that is missing, non-finite, or not the created target', () => {
    const child = executionChild('A1', SEED_A);
    const withGeometry = (targetGeometry: unknown) =>
      validateCrosswordExecutionChild({ ...child, targetGeometry });
    expect(withGeometry(undefined).ok).toBe(false);
    expect(withGeometry({ id: 'cw-A1', x: 0, y: 0, width: Number.NaN, height: 1 }).ok).toBe(false);
    expect(withGeometry({ id: 'other', x: 0, y: 0, width: 1, height: 1 }).ok).toBe(false);
    expect(withGeometry({ id: 'cw-A1', x: 0, y: 0, width: 0, height: 1 }).ok).toBe(false);
  });
});

function coherentCapture() {
  const id = 'cw-A1';
  const cursor = {
    schemaVersion: 1,
    documentId: `doc-${id}`,
    documentEpoch: 1,
    bridgeVersion: 7,
    bridgeGeneration: 1,
    revision: 4,
  };
  const raster = generatedVectorRaster({
    id,
    rendererFingerprint: 'renderer-A1',
    rasterFingerprint: 'raster-A1',
  }) as ReturnType<typeof generatedVectorRaster> & {
    renderer: { target: { id: string } };
    capture: { started: typeof cursor; completed: typeof cursor };
  };
  raster.renderer = { ...raster.renderer, target: { id } };
  raster.capture = { ...raster.capture, started: { ...cursor }, completed: { ...cursor } };
  return {
    a0: { ...cursor },
    a1: { ...cursor },
    snapshot: { observation: { ...cursor }, activeLayoutId: 'layout-a' },
    geometry: {
      observation: { ...cursor },
      id,
      mounted: true,
      visible: true,
      viewportRect: { x: 10, y: 20, width: 40, height: 40 },
      renderer: { targetFingerprint: 'renderer-A1', bridgeGeneration: 1 },
    },
    raster: { record: raster, diagnostic: null },
    createdTargetId: id,
    activeLayoutId: 'layout-a',
  };
}

describe('[WP5 Slice 5-E] remediation — full coherent capture predicate', () => {
  it('accepts one coherent A0/snapshot/geometry/R0R1/A1 bundle', () => {
    expect(evaluateCrosswordCaptureCoherence(coherentCapture())).toBeNull();
  });

  it('tears on a revision, target, renderer, or region disagreement', () => {
    const base = coherentCapture();
    expect(
      evaluateCrosswordCaptureCoherence({ ...base, a1: { ...base.a0, revision: 5 } }),
    ).toContain('A1');
    expect(
      evaluateCrosswordCaptureCoherence({
        ...base,
        raster: { record: { ...base.raster.record, id: 'other' }, diagnostic: null },
      }),
    ).not.toBeNull();
    expect(
      evaluateCrosswordCaptureCoherence({
        ...base,
        geometry: { ...base.geometry, renderer: { targetFingerprint: 'other' } },
      }),
    ).not.toBeNull();
    expect(
      evaluateCrosswordCaptureCoherence({
        ...base,
        geometry: { ...base.geometry, viewportRect: { x: 40, y: 20, width: 40, height: 40 } },
      }),
    ).not.toBeNull();
  });
});

function outcomeOf(evaluation: ReturnType<typeof evaluateCrosswordOracle>) {
  return classifyOutcome({
    requiredChecks: evaluation.checks,
    cleanupSucceeded: true,
    requiredSourcesAgree: evaluation.requiredSourcesAgree,
    harnessInvalid: evaluation.harnessInvalid,
    environmentInvalid: false,
  });
}

describe('[WP5 Slice 5-E] remediation — bounded readiness deadline', () => {
  it('resolves a bounded await and rejects a hung promise at the deadline', async () => {
    const frozen = () => 0;
    await expect(withinDeadline(Promise.resolve('ready'), 1_000, frozen, 'fast')).resolves.toEqual({
      ok: true,
      value: 'ready',
    });
    const hung = await withinDeadline(new Promise(() => undefined), 5, frozen, 'hung');
    expect(hung.ok).toBe(false);
    const rejected = await withinDeadline(
      Promise.reject(new Error('boom')),
      1_000,
      frozen,
      'rejected',
    );
    expect(rejected.ok).toBe(false);
  });
});
