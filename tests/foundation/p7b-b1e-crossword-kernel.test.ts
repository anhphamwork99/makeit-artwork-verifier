import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { generateCrosswordLayout } from '@/lib/artwork/crosswordEngine/layout';

import {
  CROSSWORD_DEFAULT_WORDS,
  CROSSWORD_GENERATOR_SOURCE_PATH,
  CROSSWORD_STORE_SOURCE_PATH,
  crosswordSemanticDigest,
  crosswordSemanticPayloadFromLayerShape,
  crosswordWordsFingerprint,
  validateCrosswordSourceContract,
} from '../../src/contracts/crossword';
import {
  CROSSWORD_CLOCK_PROFILE_ID,
  CROSSWORD_COMPARISON_PROFILE_ID,
  CROSSWORD_OBSERVATION_SCHEMA_VERSION,
  type CrosswordExecutionRole,
} from '../../src/contracts/crossword-observation';
import type { GeneratedVectorRasterRecordView } from '../../src/contracts/raster';
import { CHECK_RESULT_CONTRACT_SCHEMA_VERSION } from '../../src/contracts/schema-versions';
import { WALL_CLOCK_NAMESPACE, WALL_CLOCK_PROVIDER_ID } from '../../src/contracts/wall-clock';
import { evaluateCrosswordOracle, type CrosswordOracleInput } from '../../src/oracles/crossword';
import {
  compileResolvedCorrectnessProfile,
  crosswordCurrentnessForAuthority,
  crosswordKernelKindForEvaluator,
  deriveResolvedCorrectnessProfileFingerprint,
  evaluateCrosswordChecks,
  isFullCanonicalFingerprint,
  loadCorrectnessCatalogue,
  projectCorrectnessProfileIdentity,
  resolveRouteSelection,
  validateResultIdentityAgreement,
} from '../../src/index';
import type {
  ActionCycleCorrectnessIdentity,
  CorrectnessCheckResult,
  CorrectnessProfileIdentityView,
  CrosswordAuthorityState,
  CrosswordEvidenceAvailability,
  CrosswordEvidenceFact,
  CrosswordKernelFacts,
  CrosswordKernelIssueCode,
  CrosswordKernelResult,
  ResolvedCorrectnessProfile,
} from '../../src/index';

/**
 * P7-B B1-E inactive compiled-profile Crossword kernel tests (ADR 0028 §3
 * B1-E).
 *
 * The kernel is pure and inactive: it is never reached from an active executor,
 * Oracle, classifier, or writer. These tests drive it directly — including with
 * real `evaluateCrosswordOracle` facts over the accepted product generator and
 * source contract — and independently re-validate every produced check with the
 * B1-A compiled-profile/result agreement validator.
 */

const WORDS = [...CROSSWORD_DEFAULT_WORDS];
const BASELINE_A = '2026-01-02T03:04:05.000Z';
const BASELINE_B = '1970-01-02T10:17:36.789Z';
// The documented 2 ms collision: a distinct B baseline that still yields the
// same semantic digest as A1 (ADR 0018 CR9 / WP5 Slice 5-E).
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

const ROUTE = {
  subjectId: 'layer/crossword',
  capability: 'create' as const,
  variant: null,
};

const CHECKS = [
  'crossword.created',
  'crossword.different-seed-sensitive',
  'crossword.raster-current',
  'crossword.same-seed-repeatable',
  'crossword.seed-derived',
  'crossword.semantic-valid',
];

// ── Real accepted generator / execution facts ────────────────────────────────

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
  // Exact projection quantization: ceil(40 × 1) = 40.
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
  words: readonly string[] = WORDS,
) {
  const declaredWords = [...words];
  const layoutSeed = (overrides.layoutSeed as number | undefined) ?? seed;
  const layout = generateCrosswordLayout(declaredWords, layoutSeed);
  const structural = crosswordSemanticPayloadFromLayerShape(
    { words: declaredWords, layout },
    declaredWords,
  );
  if (!structural.ok || structural.payload === null) throw new Error('fixture layout invalid');
  const semanticDigest = crosswordSemanticDigest(structural.payload);
  const createdTargetId = `cw-${executionRole}`;
  const documentId = `doc-${executionRole}`;
  const rasterFingerprint = `raster-${executionRole}`;
  const rendererFingerprint = `renderer-${executionRole}`;
  const { layoutSeed: _ignored, ...remaining } = overrides as Record<string, unknown>;
  void _ignored;
  return {
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
    words: declaredWords,
    layout,
    semanticDigest,
    // Accepted live target geometry; the generated-vector raster region agrees
    // with it within RENDER_TRANSFORM_CSS.
    targetGeometry: { id: createdTargetId, x: 10, y: 20, width: 40, height: 40 },
    raster: generatedVectorRaster({ id: createdTargetId, rendererFingerprint, rasterFingerprint }),
    observationId: `obs-${executionRole}`,
    tornRecaptureCount: 0,
    contextClosed: true,
    ...remaining,
  };
}

interface ExecutionSetInput {
  clock: ReturnType<typeof clock>;
  sourceFingerprintExpected: string;
  executions: unknown[];
}

function executionSet(
  seeds: readonly [number, number, number],
  words: readonly string[] = WORDS,
): ExecutionSetInput {
  return {
    clock: clock([
      new Date(seeds[0]).toISOString(),
      new Date(seeds[1]).toISOString(),
      new Date(seeds[2]).toISOString(),
    ]),
    sourceFingerprintExpected: SOURCE_FINGERPRINT,
    executions: [
      executionChild('A1', seeds[0], {}, words),
      executionChild('A2', seeds[1], {}, words),
      executionChild('B', seeds[2], {}, words),
    ],
  };
}

// ── Kernel scaffolding ───────────────────────────────────────────────────────

const catalogue = loadCorrectnessCatalogue();

function compile(): ResolvedCorrectnessProfile {
  const selection = resolveRouteSelection(catalogue, ROUTE);
  if (selection === null) throw new Error('missing Crossword route selection');
  const compiled = compileResolvedCorrectnessProfile({
    catalogue,
    selection,
    declaredChecks: [],
  });
  if (!compiled.ok) throw new Error('Crossword route failed to compile');
  return compiled.profile;
}

const profile = compile();
const identity = projectCorrectnessProfileIdentity(profile);

function cycle(
  source: ResolvedCorrectnessProfile = profile,
  id = 'action-cycle-crossword-1',
): ActionCycleCorrectnessIdentity {
  return {
    schemaVersion: CHECK_RESULT_CONTRACT_SCHEMA_VERSION,
    actionCycleId: id,
    resolvedProfileFingerprint: source.resolvedFingerprint,
    readinessFingerprint: source.componentFingerprints.readiness,
  };
}

function evidenceAll(
  source: ResolvedCorrectnessProfile = profile,
  overrides: Readonly<Record<string, CrosswordEvidenceAvailability>> = {},
): CrosswordEvidenceFact[] {
  return source.requiredAuthoritativeEvidence.map((evidenceId) => ({
    evidenceId,
    availability: overrides[evidenceId] ?? 'authoritative',
  }));
}

/** Projects the delivered Oracle's additive primitive facts into structured facts. */
function structuredChecks(
  evaluation: ReturnType<typeof evaluateCrosswordOracle>,
): CrosswordKernelFacts['checks'] {
  const authority = evaluation.primitiveFacts.authority === 'malformed' ? 'malformed' : 'current';
  const sourcesAgree = evaluation.primitiveFacts.sourceAgreement === true;
  return evaluation.primitiveFacts.checks.map((check) => ({
    checkId: check.checkId,
    authority,
    currentness: crosswordCurrentnessForAuthority(authority),
    sourcesAgree,
    mismatch: authority === 'malformed' ? false : check.predicateMet !== true,
  }));
}

function oracleFacts(
  evaluation: ReturnType<typeof evaluateCrosswordOracle>,
): CrosswordKernelFacts['oracleFacts'] {
  const primitive = evaluation.primitiveFacts;
  return {
    authority: primitive.authority,
    sourceAgreement: primitive.sourceAgreement === true,
    comparison:
      primitive.comparison === null
        ? null
        : {
            sameSeedPair: primitive.comparison.sameSeedPair === true,
            differentSeedPair: primitive.comparison.differentSeedPair === true,
            repeatIdentical: primitive.comparison.repeatIdentical === true,
            seedSensitivity: primitive.comparison.seedSensitivity === true,
            collision: primitive.comparison.collision === true,
            wordsEqualAcrossChildren: primitive.comparison.wordsEqualAcrossChildren === true,
            distinctDocuments: primitive.comparison.distinctDocuments === true,
          },
    clockEpochs: Array.isArray(primitive.clockEpochs) ? [...primitive.clockEpochs] : null,
    currentnessDistinct: primitive.currentnessDistinct === true,
    rasterCurrent: primitive.rasterCurrent === true,
    checks: primitive.checks.map((check) => ({
      checkId: check.checkId,
      predicateMet: check.predicateMet === true,
    })),
  };
}

function factsFor(
  input: CrosswordOracleInput,
  overrides: Partial<CrosswordKernelFacts> = {},
): CrosswordKernelFacts {
  const evaluation = evaluateCrosswordOracle(input);
  return {
    evaluator: 'crossword-determinism',
    clock: input.clock,
    sourceFingerprintExpected: input.sourceFingerprintExpected,
    executions: input.executions,
    checks: structuredChecks(evaluation),
    comparison: evaluation.comparison,
    oracleFacts: oracleFacts(evaluation),
    diagnostics: evaluation.diagnostics.map((entry) => ({
      code: entry.code,
      detail: entry.detail,
    })),
    evidence: evidenceAll(),
    ...overrides,
  };
}

function run(
  facts: CrosswordKernelFacts,
  source: ResolvedCorrectnessProfile = profile,
): CrosswordKernelResult {
  return evaluateCrosswordChecks({
    profile: source,
    route: ROUTE,
    actionCycle: cycle(source),
    facts,
  });
}

function codes(result: CrosswordKernelResult): CrosswordKernelIssueCode[] {
  return result.issues.map((entry) => entry.code);
}

function statusFor(result: CrosswordKernelResult, checkId: string): string | undefined {
  return result.checks.find((check) => check.checkId === checkId)?.status;
}

function checkFor(result: CrosswordKernelResult, checkId: string): CorrectnessCheckResult {
  const check = result.checks.find((candidate) => candidate.checkId === checkId);
  if (check === undefined) throw new Error(`missing check ${checkId}`);
  return check;
}

function agreement(
  view: CorrectnessProfileIdentityView,
  aCycle: ActionCycleCorrectnessIdentity,
  checks: readonly CorrectnessCheckResult[],
) {
  return validateResultIdentityAgreement(view, { actionCycles: [aCycle], requiredChecks: checks });
}

function tamperedProfile(mutate: (profile: Record<string, unknown>) => void) {
  const clone = structuredClone(profile) as unknown as Record<string, unknown>;
  mutate(clone);
  return clone as unknown as ResolvedCorrectnessProfile;
}

const EVIDENCE_BY_CHECK: Readonly<Record<string, string[]>> = Object.fromEntries(
  profile.requiredChecks.map((contract) => [
    contract.checkId,
    [...contract.requiredEvidence].sort(),
  ]),
);

// ── Positive results ─────────────────────────────────────────────────────────

describe('[P7-B B1-E] Crossword kernel positive results', () => {
  it('produces a complete PASS result for every declared check from real Oracle facts', () => {
    const evaluation = evaluateCrosswordOracle(executionSet([SEED_A, SEED_A, SEED_B]));
    expect(evaluation.harnessInvalid).toBe(false);
    expect(evaluation.checks.every((check) => check.passed)).toBe(true);

    const result = run(factsFor(executionSet([SEED_A, SEED_A, SEED_B])));
    expect(result.ok).toBe(true);
    expect(result.kind).toBe('crossword-determinism');
    expect(result.checks.map((check) => check.checkId)).toEqual(CHECKS);
    expect(result.checks).toHaveLength(profile.requiredChecks.length);

    for (const check of result.checks) {
      expect(check.status).toBe('PASS');
      expect(check.schemaVersion).toBe(CHECK_RESULT_CONTRACT_SCHEMA_VERSION);
      expect(check.evidenceIds).toEqual(EVIDENCE_BY_CHECK[check.checkId]);
      expect(check.visualRefs).toEqual([]);
      expect(check.normalizationRef).toBeNull();
      expect(check.actionCycleRef).toBe('action-cycle-crossword-1');
      expect(check.actual.authority).toBe('current');
      expect(check.consumedComponentFingerprints).toEqual({
        resolvedProfile: profile.resolvedFingerprint,
        requiredCheckSet: profile.componentFingerprints.requiredCheckSet,
        oracle: profile.componentFingerprints.oracle,
        capture: profile.componentFingerprints.capture,
        tolerances: profile.componentFingerprints.tolerances,
        visuals: profile.componentFingerprints.visuals,
        normalization: profile.componentFingerprints.normalization,
      });
    }
    expect(agreement(identity, cycle(), result.checks).ok).toBe(true);
  });

  it('carries the exact compiled check schemas, tolerances, and references per check', () => {
    const result = run(factsFor(executionSet([SEED_A, SEED_A, SEED_B])));
    for (const contract of profile.requiredChecks) {
      const check = checkFor(result, contract.checkId);
      expect(check.expected.schema).toBe(contract.expectedSchema);
      expect(check.actual.schema).toBe(contract.actualSchema);
      expect(check.toleranceRefs).toEqual([...contract.toleranceRefs].sort());
      expect(check.visualRefs).toEqual([...contract.visualRefs].sort());
      expect(check.normalizationRef).toBe(contract.normalizationRef);
      expect(check.expected.requiredEvidence).toEqual([...contract.requiredEvidence].sort());
    }
    // Only the raster check carries the compiled backing-pixel tolerance.
    expect(checkFor(result, 'crossword.raster-current').toleranceRefs).toEqual([
      'backing-pixel-edge-v1',
    ]);
    expect(checkFor(result, 'crossword.created').toleranceRefs).toEqual([]);
  });

  it('publishes the governed clock/source expectations and the accepted comparison in expected/actual', () => {
    const input = executionSet([SEED_A, SEED_A, SEED_B]);
    const result = run(factsFor(input));
    for (const check of result.checks) {
      expect(check.expected.sourceFingerprintExpected).toBe(SOURCE_FINGERPRINT);
      expect(check.expected.executionRoles).toEqual(['A1', 'A2', 'B']);
      expect((check.expected.clock as Record<string, unknown>).profileId).toBe(
        CROSSWORD_CLOCK_PROFILE_ID,
      );
      expect((check.expected.clock as Record<string, unknown>).baselines).toEqual([
        new Date(SEED_A).toISOString(),
        new Date(SEED_A).toISOString(),
        new Date(SEED_B).toISOString(),
      ]);
    }
    const repeat = checkFor(result, 'crossword.same-seed-repeatable');
    expect(repeat.actual.comparison).toMatchObject({
      sameSeedPair: true,
      differentSeedPair: true,
      repeatIdentical: true,
      seedSensitivity: true,
      wordsEqualAcrossChildren: true,
    });
    expect(repeat.actual.executionAuthority).toBe('current');
    const children = repeat.actual.children as Record<string, unknown>[];
    expect(children.map((child) => child.executionRole)).toEqual(['A1', 'A2', 'B']);
    expect(children.every((child) => child.present === true)).toBe(true);
    expect(children.map((child) => child.actualSeed)).toEqual([SEED_A, SEED_A, SEED_B]);
  });

  it('preserves the accepted repeat/seed-sensitivity comparison semantics', () => {
    const result = run(factsFor(executionSet([SEED_A, SEED_A, SEED_B])));
    const comparison = checkFor(result, 'crossword.different-seed-sensitive').actual
      .comparison as Record<string, unknown>;
    expect(comparison.seeds).toEqual({ A1: SEED_A, A2: SEED_A, B: SEED_B });
    expect(comparison.differentSeedPair).toBe(true);
    expect(comparison.seedSensitivity).toBe(true);
    expect(comparison.repeatIdentical).toBe(true);
  });

  it('structurally accepts the delivered CrosswordOracleEvaluation projection', () => {
    const input = executionSet([SEED_A, SEED_A, SEED_B]);
    const evaluation = evaluateCrosswordOracle(input);
    const facts: CrosswordKernelFacts = {
      evaluator: 'crossword-determinism',
      clock: input.clock,
      sourceFingerprintExpected: input.sourceFingerprintExpected,
      executions: input.executions,
      checks: structuredChecks(evaluation),
      comparison: evaluation.comparison,
      oracleFacts: oracleFacts(evaluation),
      diagnostics: evaluation.diagnostics,
      evidence: evidenceAll(),
    };
    expect(run(facts).checks.every((check) => check.status === 'PASS')).toBe(true);
  });
});

// ── Trustworthy mismatch / collision / non-convergence -> FAIL ────────────────

describe('[P7-B B1-E] trustworthy mismatch/collision/non-convergence maps to FAIL', () => {
  it('fails only different-seed-sensitive for the documented 2 ms seed collision', () => {
    const input = executionSet([SEED_A, SEED_A, SEED_COLLISION]);
    const evaluation = evaluateCrosswordOracle(input);
    expect(evaluation.harnessInvalid).toBe(false);
    expect(evaluation.comparison?.seedSensitivity).toBe(false);

    const result = run(factsFor(input));
    expect(result.ok).toBe(true);
    expect(statusFor(result, 'crossword.different-seed-sensitive')).toBe('FAIL');
    for (const checkId of [
      'crossword.created',
      'crossword.raster-current',
      'crossword.same-seed-repeatable',
      'crossword.seed-derived',
      'crossword.semantic-valid',
    ]) {
      expect(statusFor(result, checkId)).toBe('PASS');
    }
    expect(checkFor(result, 'crossword.different-seed-sensitive').actual.authority).toBe('current');
    expect(agreement(identity, cycle(), result.checks).ok).toBe(true);
  });

  it('fails only same-seed-repeatable when A2 diverges at the same clock baseline', () => {
    const input = executionSet([SEED_A, SEED_A, SEED_B]);
    (input.executions as unknown[])[1] = executionChild('A2', SEED_A, { layoutSeed: SEED_B });
    const evaluation = evaluateCrosswordOracle(input);
    expect(evaluation.harnessInvalid).toBe(false);

    const result = run(factsFor(input));
    expect(statusFor(result, 'crossword.same-seed-repeatable')).toBe('FAIL');
    expect(statusFor(result, 'crossword.different-seed-sensitive')).toBe('PASS');
    expect(statusFor(result, 'crossword.raster-current')).toBe('PASS');
    expect(checkFor(result, 'crossword.same-seed-repeatable').actual.authority).toBe('current');
    expect(agreement(identity, cycle(), result.checks).ok).toBe(true);
  });

  it('fails only raster-current for a coherent but off-target projection region', () => {
    const input = executionSet([SEED_A, SEED_A, SEED_B]);
    const first = input.executions[0] as ReturnType<typeof executionChild>;
    (input.executions as unknown[])[0] = {
      ...first,
      raster: {
        ...first.raster,
        region:
          first.raster.region === null
            ? null
            : { ...first.raster.region, x: first.raster.region.x + 30 },
      },
    };
    const evaluation = evaluateCrosswordOracle(input);
    expect(evaluation.harnessInvalid).toBe(false);

    const result = run(factsFor(input));
    expect(statusFor(result, 'crossword.raster-current')).toBe('FAIL');
    expect(statusFor(result, 'crossword.created')).toBe('PASS');
    expect(statusFor(result, 'crossword.same-seed-repeatable')).toBe('PASS');
    expect(checkFor(result, 'crossword.raster-current').actual.authority).toBe('current');
    expect(agreement(identity, cycle(), result.checks).ok).toBe(true);
  });

  it('fails only semantic-valid for a coherent non-default word set at every child', () => {
    const input = executionSet([SEED_A, SEED_A, SEED_B], ['MAKEIT', 'CROSSWORD']);
    const evaluation = evaluateCrosswordOracle(input);
    expect(evaluation.harnessInvalid).toBe(false);
    expect(
      evaluation.checks.find((check) => check.checkId === 'crossword.semantic-valid')?.passed,
    ).toBe(false);

    const result = run(factsFor(input));
    expect(statusFor(result, 'crossword.semantic-valid')).toBe('FAIL');
    expect(statusFor(result, 'crossword.created')).toBe('PASS');
    expect(statusFor(result, 'crossword.seed-derived')).toBe('PASS');
    expect(statusFor(result, 'crossword.raster-current')).toBe('PASS');
    expect(checkFor(result, 'crossword.semantic-valid').actual.authority).toBe('current');
    expect(agreement(identity, cycle(), result.checks).ok).toBe(true);
  });

  it('fails seed-derived for a current, interpretable wrong seed while authority stays current', () => {
    const input = executionSet([SEED_A, SEED_A, SEED_B]);
    const first = input.executions[0] as ReturnType<typeof executionChild>;
    (input.executions as unknown[])[0] = {
      ...first,
      actualSeed: SEED_A + 1,
      currentness: { ...first.currentness, generationSeed: SEED_A + 1 },
    };
    const evaluation = evaluateCrosswordOracle(input);
    expect(evaluation.harnessInvalid).toBe(false);

    const result = run(factsFor(input));
    expect(statusFor(result, 'crossword.seed-derived')).toBe('FAIL');
    expect(statusFor(result, 'crossword.raster-current')).toBe('PASS');
    expect(checkFor(result, 'crossword.seed-derived').actual.authority).toBe('current');
    expect(agreement(identity, cycle(), result.checks).ok).toBe(true);
  });

  it('never lets a passing check rescue a failed one', () => {
    const input = executionSet([SEED_A, SEED_A, SEED_COLLISION]);
    const result = run(factsFor(input));
    expect(statusFor(result, 'crossword.different-seed-sensitive')).toBe('FAIL');
    expect(statusFor(result, 'crossword.semantic-valid')).toBe('PASS');
  });
});

// ── Missing/stale/torn/wrong-target/malformed -> UNUSABLE ─────────────────────

describe('[P7-B B1-E] missing/stale/torn/wrong-target/malformed authority maps to UNUSABLE', () => {
  function verifyUnusable(result: CrosswordKernelResult, authority: CrosswordAuthorityState): void {
    expect(result.ok).toBe(true);
    expect(result.checks).toHaveLength(profile.requiredChecks.length);
    expect(result.checks.every((check) => check.status === 'UNUSABLE')).toBe(true);
    for (const check of result.checks) {
      expect(check.actual.authority).toBe(authority);
    }
  }

  it('is UNUSABLE for every check when the execution set has no children', () => {
    const input = executionSet([SEED_A, SEED_A, SEED_B]);
    input.executions = [];
    const evaluation = evaluateCrosswordOracle(input);
    expect(evaluation.harnessInvalid).toBe(true);
    const result = run(factsFor(input));
    verifyUnusable(result, 'missing');
    expect(codes(result)).toContain('CROSSWORD_KERNEL_EXECUTION_AUTHORITY_UNUSABLE');
  });

  it('is UNUSABLE when a required execution role is missing', () => {
    const input = executionSet([SEED_A, SEED_A, SEED_B]);
    input.executions = input.executions.slice(0, 2);
    const result = run(factsFor(input));
    verifyUnusable(result, 'missing');
  });

  it('is UNUSABLE for accepted source drift (stale materialization)', () => {
    const input = executionSet([SEED_A, SEED_A, SEED_B]);
    input.sourceFingerprintExpected = 'f'.repeat(64);
    const evaluation = evaluateCrosswordOracle(input);
    expect(evaluation.harnessInvalid).toBe(true);
    const result = run(factsFor(input));
    verifyUnusable(result, 'stale');
    expect(codes(result)).toContain('CROSSWORD_KERNEL_SOURCE_DRIFT');
  });

  it('is UNUSABLE for a pending (stale) raster record', () => {
    const input = executionSet([SEED_A, SEED_A, SEED_B]);
    const first = input.executions[0] as ReturnType<typeof executionChild>;
    (input.executions as unknown[])[0] = {
      ...first,
      raster: { ...first.raster, status: 'pending' },
    };
    const result = run(factsFor(input));
    verifyUnusable(result, 'stale');
  });

  it('is UNUSABLE for a torn raster record', () => {
    const input = executionSet([SEED_A, SEED_A, SEED_B]);
    const first = input.executions[0] as ReturnType<typeof executionChild>;
    (input.executions as unknown[])[0] = {
      ...first,
      raster: { ...first.raster, status: 'torn', reason: 'observation-changed' },
    };
    const result = run(factsFor(input));
    verifyUnusable(result, 'torn');
    expect(codes(result)).toContain('CROSSWORD_KERNEL_EXECUTION_AUTHORITY_UNUSABLE');
  });

  it('is UNUSABLE for a wrong-target raster record', () => {
    const input = executionSet([SEED_A, SEED_A, SEED_B]);
    const first = input.executions[0] as ReturnType<typeof executionChild>;
    (input.executions as unknown[])[0] = {
      ...first,
      raster: { ...first.raster, id: 'other-target' },
    };
    const result = run(factsFor(input));
    verifyUnusable(result, 'wrong-target');
  });

  it('is UNUSABLE (malformed) for a malformed raster authority discriminant', () => {
    const input = executionSet([SEED_A, SEED_A, SEED_B]);
    const first = input.executions[0] as ReturnType<typeof executionChild>;
    (input.executions as unknown[])[0] = {
      ...first,
      raster: { ...first.raster, authorityKind: 'not-a-projection-arm' },
    };
    const result = run(factsFor(input));
    verifyUnusable(result, 'malformed');
  });

  it('is UNUSABLE for a non-object child observation (malformed)', () => {
    const input = executionSet([SEED_A, SEED_A, SEED_B]);
    (input.executions as unknown[])[0] = null;
    const result = run(factsFor(input));
    verifyUnusable(result, 'malformed');
  });

  it('is UNUSABLE for a reused document identity (ambiguous)', () => {
    const input = executionSet([SEED_A, SEED_A, SEED_B]);
    const second = input.executions[1] as ReturnType<typeof executionChild>;
    (input.executions as unknown[])[1] = {
      ...second,
      currentness: { ...second.currentness, documentId: 'doc-A1' },
    };
    const result = run(factsFor(input));
    verifyUnusable(result, 'ambiguous');
  });

  it('is UNUSABLE when a structured evaluator fact reports malformed authority', () => {
    const facts = factsFor(executionSet([SEED_A, SEED_A, SEED_B]));
    const result = run({
      ...facts,
      checks: facts.checks.map((check) =>
        check.checkId === 'crossword.raster-current'
          ? { ...check, authority: 'malformed' as const, mismatch: false }
          : check,
      ),
    });
    expect(statusFor(result, 'crossword.raster-current')).toBe('UNUSABLE');
    expect(checkFor(result, 'crossword.raster-current').actual.authority).toBe('malformed');
    expect(statusFor(result, 'crossword.created')).toBe('PASS');
  });

  it('is UNUSABLE for a declared check with no accepted fact', () => {
    const facts = factsFor(executionSet([SEED_A, SEED_A, SEED_B]));
    const result = run({
      ...facts,
      checks: facts.checks.filter((check) => check.checkId !== 'crossword.seed-derived'),
    });
    expect(codes(result)).toContain('CROSSWORD_KERNEL_FACT_CHECK_MISSING');
    expect(statusFor(result, 'crossword.seed-derived')).toBe('UNUSABLE');
    expect(statusFor(result, 'crossword.raster-current')).toBe('PASS');
  });
});

// ── Warnings only for trustworthy mismatches / diagnostic isolation ──────────

describe('[P7-B B1-E] warnings only trustworthy mismatches', () => {
  it('carries the product seed-collision warning only with a current FAIL', () => {
    const input = executionSet([SEED_A, SEED_A, SEED_COLLISION]);
    const evaluation = evaluateCrosswordOracle(input);
    expect(evaluation.diagnostics.map((entry) => entry.code)).toContain(
      'PRODUCT_CROSSWORD_SEED_INSENSITIVE',
    );
    const result = run(factsFor(input));
    const failed = checkFor(result, 'crossword.different-seed-sensitive');
    expect(failed.status).toBe('FAIL');
    expect(failed.actual.authority).toBe('current');
    expect(failed.actual.diagnosticCodes).toContain('PRODUCT_CROSSWORD_SEED_INSENSITIVE');
    // A trustworthy product mismatch is never accompanied by an unusable issue.
    expect(codes(result)).not.toContain('CROSSWORD_KERNEL_EXECUTION_AUTHORITY_UNUSABLE');
  });

  it('carries the product raster warning only with a current FAIL, never for unusable authority', () => {
    const input = executionSet([SEED_A, SEED_A, SEED_B]);
    const first = input.executions[0] as ReturnType<typeof executionChild>;
    (input.executions as unknown[])[0] = {
      ...first,
      raster: {
        ...first.raster,
        region:
          first.raster.region === null
            ? null
            : { ...first.raster.region, x: first.raster.region.x + 30 },
      },
    };
    const evaluation = evaluateCrosswordOracle(input);
    expect(evaluation.harnessInvalid).toBe(false);
    const result = run(factsFor(input));
    const failed = checkFor(result, 'crossword.raster-current');
    expect(failed.status).toBe('FAIL');
    expect(failed.actual.authority).toBe('current');
    expect(failed.actual.diagnosticCodes).toContain('PRODUCT_CROSSWORD_RASTER_INVALID');
  });

  it('never converts unusable raster authority into a product warning', () => {
    const input = executionSet([SEED_A, SEED_A, SEED_B]);
    const first = input.executions[0] as ReturnType<typeof executionChild>;
    (input.executions as unknown[])[0] = {
      ...first,
      raster: { ...first.raster, status: 'torn', reason: 'observation-changed' },
    };
    const evaluation = evaluateCrosswordOracle(input);
    expect(evaluation.harnessInvalid).toBe(true);
    const result = run(factsFor(input));
    expect(result.checks.every((check) => check.status === 'UNUSABLE')).toBe(true);
    expect(codes(result)).toContain('CROSSWORD_KERNEL_EXECUTION_AUTHORITY_UNUSABLE');
    const codesSeen = checkFor(result, 'crossword.raster-current').actual
      .diagnosticCodes as string[];
    expect(codesSeen).toContain('CROSSWORD_RASTER_AUTHORITY_UNUSABLE');
    expect(codesSeen).not.toContain('PRODUCT_CROSSWORD_RASTER_INVALID');
    expect(codesSeen).not.toContain('PRODUCT_CROSSWORD_SEED_MISMATCH');
  });

  it('never lets a product warning turn an unusable check into PASS/FAIL', () => {
    const input = executionSet([SEED_A, SEED_A, SEED_B]);
    const facts = factsFor(input, {
      diagnostics: [
        { code: 'PRODUCT_CROSSWORD_RASTER_INVALID', detail: 'synthetic' },
        { code: 'PRODUCT_CROSSWORD_SEED_MISMATCH', detail: 'synthetic' },
      ],
    });
    const withMalformed = {
      ...facts,
      checks: facts.checks.map((check) =>
        check.checkId === 'crossword.raster-current'
          ? { ...check, authority: 'malformed' as const, mismatch: false }
          : check,
      ),
    };
    const result = run(withMalformed);
    expect(statusFor(result, 'crossword.raster-current')).toBe('UNUSABLE');
    expect(statusFor(result, 'crossword.created')).toBe('PASS');
  });
});

describe('[P7-B B1-E] required evidence and diagnostic isolation', () => {
  it('never consumes a diagnostic-only item declared for required authority', () => {
    const result = run(
      factsFor(executionSet([SEED_A, SEED_A, SEED_B]), {
        evidence: evidenceAll(profile, { 'raster.accepted': 'diagnostic-only' }),
      }),
    );
    expect(codes(result)).toContain('CROSSWORD_KERNEL_EVIDENCE_DIAGNOSTIC_ONLY');
    expect(statusFor(result, 'crossword.raster-current')).toBe('UNUSABLE');
    expect(statusFor(result, 'crossword.semantic-valid')).toBe('PASS');
    const raster = checkFor(result, 'crossword.raster-current');
    expect(raster.evidenceIds).toEqual(['crossword.observation-baseline']);
    expect(raster.evidenceIds).not.toContain('raster.accepted');
  });

  it('is UNUSABLE and consumes no torn evidence while other checks pass', () => {
    const result = run(
      factsFor(executionSet([SEED_A, SEED_A, SEED_B]), {
        evidence: evidenceAll(profile, { observation: 'torn' }),
      }),
    );
    const created = checkFor(result, 'crossword.created');
    expect(created.status).toBe('UNUSABLE');
    expect(created.actual.authority).toBe('torn');
    expect(created.evidenceIds).toEqual(['crossword.observation-baseline']);
    expect(statusFor(result, 'crossword.raster-current')).toBe('PASS');
    expect(statusFor(result, 'crossword.same-seed-repeatable')).toBe('PASS');
    expect(agreement(identity, cycle(), result.checks).ok).toBe(true);
  });

  it('maps a missing required evidence item to UNUSABLE for exactly the dependent checks', () => {
    const result = run(
      factsFor(executionSet([SEED_A, SEED_A, SEED_B]), {
        evidence: evidenceAll().filter(
          (fact) => fact.evidenceId !== 'crossword.observation-repeat',
        ),
      }),
    );
    expect(statusFor(result, 'crossword.same-seed-repeatable')).toBe('UNUSABLE');
    expect(statusFor(result, 'crossword.created')).toBe('PASS');
    expect(statusFor(result, 'crossword.different-seed-sensitive')).toBe('PASS');
    expect(checkFor(result, 'crossword.same-seed-repeatable').actual.authority).toBe('missing');
  });

  it('reports undeclared evidence claiming authority without consuming it', () => {
    const result = run(
      factsFor(executionSet([SEED_A, SEED_A, SEED_B]), {
        evidence: [
          ...evidenceAll(),
          { evidenceId: 'crossword.raw-payload.diagnostic', availability: 'authoritative' },
          { evidenceId: 'screenshot.diagnostic', availability: 'authoritative' },
        ],
      }),
    );
    expect(codes(result)).toContain('CROSSWORD_KERNEL_EVIDENCE_UNDECLARED');
    for (const check of result.checks) {
      expect(check.evidenceIds).not.toContain('crossword.raw-payload.diagnostic');
      expect(check.evidenceIds).not.toContain('screenshot.diagnostic');
    }
  });

  it('consumes exactly the compiled required evidence for every PASS check', () => {
    const result = run(factsFor(executionSet([SEED_A, SEED_A, SEED_B])));
    expect(result.ok).toBe(true);
    expect(codes(result)).not.toContain('CROSSWORD_KERNEL_EVIDENCE_UNDECLARED');
    for (const check of result.checks.filter((entry) => entry.status === 'PASS')) {
      expect(check.evidenceIds).toEqual(EVIDENCE_BY_CHECK[check.checkId]);
      expect(check.evidenceIds.length).toBeGreaterThan(0);
    }
  });
});

// ── Compiled-profile identity, route, action cycle, evaluators ───────────────

describe('[P7-B B1-E] compiled-profile identity agreement', () => {
  function runWith(
    source: ResolvedCorrectnessProfile,
    route = ROUTE,
    aCycle = cycle(source),
    facts = factsFor(executionSet([SEED_A, SEED_A, SEED_B])),
  ) {
    return evaluateCrosswordChecks({ profile: source, route, actionCycle: aCycle, facts });
  }

  it('rejects a profile for a different route without fabricating checks', () => {
    const result = evaluateCrosswordChecks({
      profile,
      route: { subjectId: 'layer/text', capability: 'move', variant: 'plain' },
      actionCycle: cycle(),
      facts: factsFor(executionSet([SEED_A, SEED_A, SEED_B])),
    });
    expect(result.ok).toBe(false);
    expect(result.checks).toEqual([]);
    expect(codes(result)).toContain('CROSSWORD_KERNEL_ROUTE_MISMATCH');
  });

  it('rejects an Action Cycle that observed a different resolved profile', () => {
    const result = runWith(profile, ROUTE, {
      ...cycle(),
      resolvedProfileFingerprint: 'a'.repeat(64),
    });
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain('CROSSWORD_KERNEL_ACTION_CYCLE_MISMATCH');
  });

  it('rejects an Action Cycle readiness disagreement', () => {
    const result = runWith(profile, ROUTE, { ...cycle(), readinessFingerprint: 'b'.repeat(64) });
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain('CROSSWORD_KERNEL_READINESS_MISMATCH');
  });

  it('rejects a compiled profile whose content was mutated in place', () => {
    const result = runWith(
      tamperedProfile((entry) => {
        (entry.readiness as Record<string, unknown>).stableFrames = 99;
      }),
    );
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain('CROSSWORD_KERNEL_PROFILE_FINGERPRINT_MISMATCH');
  });

  it('rejects a missing resolved fingerprint', () => {
    const result = runWith(
      tamperedProfile((entry) => {
        entry.resolvedFingerprint = null;
      }),
    );
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain('CROSSWORD_KERNEL_PROFILE_FINGERPRINT_MISSING');
  });

  it('rejects a non-canonical resolved fingerprint', () => {
    const result = runWith(
      tamperedProfile((entry) => {
        entry.resolvedFingerprint = 'deadbeef';
      }),
    );
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain('CROSSWORD_KERNEL_PROFILE_FINGERPRINT_INVALID');
  });

  it('rejects an invalid component fingerprint', () => {
    const result = runWith(
      tamperedProfile((entry) => {
        (entry.componentFingerprints as Record<string, unknown>).oracle = 'not-a-fingerprint';
      }),
    );
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain('CROSSWORD_KERNEL_COMPONENT_FINGERPRINT_INVALID');
  });

  it('rejects an unsupported resolved-profile schema', () => {
    const result = runWith(
      tamperedProfile((entry) => {
        entry.schemaVersion = 99;
      }),
    );
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain('CROSSWORD_KERNEL_PROFILE_SCHEMA_UNSUPPORTED');
  });

  it('rejects a non-object compiled profile', () => {
    const result = evaluateCrosswordChecks({
      profile: null as unknown as ResolvedCorrectnessProfile,
      route: ROUTE,
      actionCycle: cycle(),
      facts: factsFor(executionSet([SEED_A, SEED_A, SEED_B])),
    });
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain('CROSSWORD_KERNEL_PROFILE_NOT_OBJECT');
  });

  it('emits consumed component fingerprints a disagreeing compiled identity cannot match', () => {
    const swapped = structuredClone(profile) as unknown as Record<string, unknown>;
    (swapped.componentFingerprints as Record<string, unknown>).oracle = 'c'.repeat(64);
    const { resolvedFingerprint: _drop, ...preimage } = swapped;
    void _drop;
    swapped.resolvedFingerprint = deriveResolvedCorrectnessProfileFingerprint(
      preimage as unknown as Omit<ResolvedCorrectnessProfile, 'resolvedFingerprint'>,
    );
    const swappedProfile = swapped as unknown as ResolvedCorrectnessProfile;
    const result = evaluateCrosswordChecks({
      profile: swappedProfile,
      route: ROUTE,
      actionCycle: cycle(swappedProfile),
      facts: factsFor(executionSet([SEED_A, SEED_A, SEED_B])),
    });
    expect(result.ok).toBe(true);
    const validation = agreement(identity, cycle(swappedProfile), result.checks);
    expect(validation.ok).toBe(false);
    expect(validation.issues.map((entry) => entry.code)).toContain(
      'RESULT_CONSUMED_COMPONENT_MISMATCH',
    );
  });

  it('leaves the compiled check-set/route identity stable across recompiles', () => {
    expect(compile().resolvedFingerprint).toBe(profile.resolvedFingerprint);
    expect(profile.requiredChecks.map((check) => check.checkId)).toEqual(CHECKS);
    expect(profile.requiredAuthoritativeEvidence).toEqual([
      'crossword.observation-baseline',
      'crossword.observation-repeat',
      'crossword.observation-sensitive',
      'observation',
      'raster.accepted',
    ]);
    expect(profile.diagnosticOnlyEvidence).toEqual([
      'crossword.raw-payload.diagnostic',
      'screenshot.diagnostic',
    ]);
    expect(profile.normalization).toEqual({ applicable: false });
  });
});

// ── Required-check set and evaluator discriminants ───────────────────────────

describe('[P7-B B1-E] required-check set and evaluator discriminants', () => {
  function runTampered(source: ResolvedCorrectnessProfile): CrosswordKernelResult {
    return evaluateCrosswordChecks({
      profile: source,
      route: ROUTE,
      actionCycle: cycle(source),
      facts: factsFor(executionSet([SEED_A, SEED_A, SEED_B])),
    });
  }

  it('rejects an empty required-check set', () => {
    const result = runTampered(
      tamperedProfile((entry) => {
        entry.requiredChecks = [];
      }),
    );
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain('CROSSWORD_KERNEL_EMPTY_REQUIRED_CHECKS');
  });

  it('rejects a declared check with no check id', () => {
    const result = runTampered(
      tamperedProfile((entry) => {
        entry.requiredChecks = [{ evaluator: 'crossword-determinism' }];
      }),
    );
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain('CROSSWORD_KERNEL_REQUIRED_CHECK_MISSING');
  });

  it('rejects a duplicated declared check', () => {
    const result = runTampered(
      tamperedProfile((entry) => {
        const [check] = entry.requiredChecks as unknown[];
        entry.requiredChecks = [check, check];
      }),
    );
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain('CROSSWORD_KERNEL_REQUIRED_CHECK_DUPLICATE');
  });

  it('rejects an unsupported per-check evaluator discriminant', () => {
    const result = runTampered(
      tamperedProfile((entry) => {
        const [check] = entry.requiredChecks as Record<string, unknown>[];
        (check as Record<string, unknown>).evaluator = 'canonical-delta';
      }),
    );
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain('CROSSWORD_KERNEL_CHECK_EVALUATOR_UNSUPPORTED');
  });

  it('rejects an unsupported Oracle evaluator discriminant', () => {
    const result = runTampered(
      tamperedProfile((entry) => {
        (entry.oracle as Record<string, unknown>).evaluatorKind = 'geometry-delta';
      }),
    );
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain('CROSSWORD_KERNEL_ORACLE_EVALUATOR_UNSUPPORTED');
  });

  it('rejects facts that declare a different evaluator', () => {
    const result = run({
      ...factsFor(executionSet([SEED_A, SEED_A, SEED_B])),
      evaluator: 'geometry-delta' as unknown as CrosswordKernelFacts['evaluator'],
    });
    expect(result.ok).toBe(true);
    expect(codes(result)).toContain('CROSSWORD_KERNEL_FACTS_EVALUATOR_MISMATCH');
  });

  it('rejects an accepted fact for an undeclared check without consuming it', () => {
    const facts = factsFor(executionSet([SEED_A, SEED_A, SEED_B]));
    const result = run({
      ...facts,
      checks: [
        ...facts.checks,
        {
          checkId: 'crossword.unknown',
          authority: 'current' as const,
          currentness: 'current' as const,
          sourcesAgree: true,
          mismatch: false,
        },
      ],
    });
    expect(codes(result)).toContain('CROSSWORD_KERNEL_FACT_CHECK_UNKNOWN');
    expect(result.checks.map((check) => check.checkId)).toEqual(CHECKS);
    expect(result.checks.every((check) => check.status === 'PASS')).toBe(true);
  });

  it('rejects a duplicated check fact', () => {
    const facts = factsFor(executionSet([SEED_A, SEED_A, SEED_B]));
    const result = run({
      ...facts,
      checks: [...facts.checks, facts.checks[0] as (typeof facts.checks)[number]],
    });
    expect(codes(result)).toContain('CROSSWORD_KERNEL_FACT_CHECK_DUPLICATE');
  });

  it('rejects a legacy-shaped check fact and makes it UNUSABLE', () => {
    const facts = factsFor(executionSet([SEED_A, SEED_A, SEED_B]));
    const result = run({
      ...facts,
      checks: [
        { checkId: 'crossword.raster-current', passed: true } as never,
        ...facts.checks.filter((check) => check.checkId !== 'crossword.raster-current'),
      ],
    });
    expect(codes(result)).toContain('CROSSWORD_KERNEL_FACT_AUTHORITY_UNKNOWN');
    expect(statusFor(result, 'crossword.raster-current')).toBe('UNUSABLE');
    expect(statusFor(result, 'crossword.created')).toBe('PASS');
  });

  it('routes exactly the delivered Crossword evaluator kind to the kernel', () => {
    expect(crosswordKernelKindForEvaluator('crossword-determinism')).toBe('crossword-determinism');
    expect(crosswordKernelKindForEvaluator('image-upload-replace')).toBeNull();
    expect(crosswordKernelKindForEvaluator('geometry-delta')).toBeNull();
    expect(crosswordKernelKindForEvaluator(undefined)).toBeNull();
  });
});

// ── Compiled single-leaf mutation matrix ─────────────────────────────────────

describe('[P7-B B1-E] relevant compiled-field mutation matrix', () => {
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

  const leafPaths: string[] = [];
  collectLeafPaths(profile, '', leafPaths);

  it('covers the complete compiled Crossword profile projection', () => {
    expect(leafPaths.length).toBeGreaterThanOrEqual(150);
  });

  it('rejects every single-leaf mutation of the compiled Crossword profile', () => {
    // The accepted Oracle facts are loop-invariant: recomputing the generated
    // layout for every leaf would dominate the test. Build them once.
    const baseFacts = factsFor(executionSet([SEED_A, SEED_A, SEED_B]));
    for (const leafPath of leafPaths) {
      const clone = structuredClone(profile) as unknown as Record<string, unknown>;
      mutateLeaf(clone, leafPath);
      const mutated = clone as unknown as ResolvedCorrectnessProfile;
      const result = evaluateCrosswordChecks({
        profile: mutated,
        route: ROUTE,
        actionCycle: cycle(mutated),
        facts: baseFacts,
      });
      expect(result.ok, `mutation of ${leafPath} was not detected`).toBe(false);
    }
  });
});

// ── Inactive kernel invariants ───────────────────────────────────────────────

describe('[P7-B B1-E] inactive kernel invariants', () => {
  const skillRoot = path.resolve(process.cwd());
  const source = (relative: string): string => readFileSync(path.join(skillRoot, relative), 'utf8');

  it('does not import any active executor, Oracle, readiness loop, evidence writer, or classifier', () => {
    const kernel = source('src/kernels/crossword-kernel.ts');
    expect(kernel).not.toMatch(/from '\.\.\/(runtime|oracles|readiness|evidence)\//);
    expect(kernel).not.toContain('execute-plan');
    expect(kernel).not.toContain('execute-crossword-plan');
    expect(kernel).not.toContain('contracts/execution');
    expect(kernel).not.toMatch(/from '\.\.\/runtime\/outcomes'/);
    expect(kernel).not.toMatch(/from '\.\.\/runtime\/result-outcome'/);
    expect(kernel).not.toContain("from '../oracles/crossword'");
  });

  it('is not referenced by any active executor, Oracle, or writer module', () => {
    for (const relative of [
      'src/runtime/execute-plan.ts',
      'src/runtime/execute-crossword-plan.ts',
      'src/runtime/action-cycle.ts',
      'src/oracles/evaluate.ts',
      'src/oracles/crossword.ts',
      'src/evidence/writer.ts',
      'src/evidence/public-dto.ts',
      'src/runtime/outcomes.ts',
    ]) {
      expect(source(relative)).not.toContain('crossword-kernel');
      expect(source(relative)).not.toContain('evaluateCrosswordChecks');
    }
  });

  it('leaves the active boolean CheckResult and v3 record schema unchanged', () => {
    expect(source('src/contracts/execution.ts')).toMatch(
      /export interface CheckResult \{\n {2}checkId: string;\n {2}passed: boolean;\n\}/,
    );
    expect(source('src/contracts/schema-versions.ts')).toContain(
      'export const DIAGNOSTIC_RUN_RECORD_SCHEMA_VERSION = 3;',
    );
  });

  it('keeps every produced component fingerprint full canonical', () => {
    const result = run(factsFor(executionSet([SEED_A, SEED_A, SEED_B])));
    for (const check of result.checks) {
      expect(isFullCanonicalFingerprint(check.consumedComponentFingerprints.resolvedProfile)).toBe(
        true,
      );
      expect(isFullCanonicalFingerprint(check.consumedComponentFingerprints.oracle)).toBe(true);
      expect(isFullCanonicalFingerprint(check.consumedComponentFingerprints.tolerances)).toBe(true);
    }
  });
});
