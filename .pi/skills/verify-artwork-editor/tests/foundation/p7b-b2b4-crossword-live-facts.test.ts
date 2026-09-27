import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { generateCrosswordLayout } from '@/lib/artwork/crosswordEngine/layout';

import { loadCatalogueBundle, type CatalogueBundle } from '../../src/catalogue/load';
import { loadDiagnosticSuite, resolveSuiteRequests } from '../../src/catalogue/suite';
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
  MATERIALIZED_EXECUTION_ENVELOPE_SCHEMA_VERSION,
  type MaterializedExecutionEnvelopeV1,
} from '../../src/planner/execution-materialization';
import { planCaseForExecution } from '../../src/planner/plan-case';
import { resolveSkillRoot } from '../../src/runtime/paths';
import {
  CROSSWORD_LIVE_FACT_ISSUE_CODES,
  adaptCrosswordLiveFacts,
  evaluateCrosswordLiveChecks,
  projectCrosswordLiveFacts,
  type CrosswordLiveEvaluationObservation,
  type CrosswordLiveFactFailure,
  type CrosswordLiveFactRoute,
} from '../../src/adapters/crossword-live-facts';
import {
  isFullCanonicalFingerprint,
  projectCorrectnessProfileIdentity,
  validateResultIdentityAgreement,
} from '../../src/index';
import type {
  ActionCycleCorrectnessIdentity,
  CorrectnessCheckResult,
  CrosswordEvidenceAvailability,
  CrosswordEvidenceFact,
  CrosswordKernelFacts,
} from '../../src/index';

/**
 * P7-B2-B4 focused proof: inactive live-fact adapter for generated Crossword
 * creation/determinism (ADR 0029 §4 B2-B).
 *
 * The suites drive the adapter from the *real* exact envelope produced by
 * `planCaseForExecution` for the representative Crossword request and the *real*
 * accepted `evaluateCrosswordOracle` outputs over the accepted product generator
 * and source contract. They cover PASS, a trustworthy seed collision, a repeat
 * divergence, a raster-region non-convergence, a non-default word set, a wrong
 * seed, missing/stale/torn/wrong-target/malformed/ambiguous execution authority,
 * identity/evidence agreement, fail-closed envelope rejection before the kernel,
 * no adapter policy, no active imports, no legacy boolean/harnessInvalid
 * authority in the produced structured facts, and a single-leaf mutation of
 * every compiled compatibility field.
 */

const skillRoot = resolveSkillRoot();
const bundle: CatalogueBundle = loadCatalogueBundle();

function representativeRequest(fileName: string): unknown {
  const resolved = resolveSuiteRequests(loadDiagnosticSuite('representative'));
  const entry = resolved.find((candidate) => path.basename(candidate.relativePath) === fileName);
  if (entry === undefined) throw new Error(`missing representative request ${fileName}`);
  return entry.request;
}

const CROSSWORD_REQUEST = 'layer-crossword-create.json';

interface PreparedCase {
  readonly envelope: MaterializedExecutionEnvelopeV1;
  readonly route: CrosswordLiveFactRoute;
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

const crosswordCase = prepare(CROSSWORD_REQUEST);
const profile = crosswordCase.envelope.correctnessProfile;

function cycle(actionCycleId: string): ActionCycleCorrectnessIdentity {
  return {
    schemaVersion: CHECK_RESULT_CONTRACT_SCHEMA_VERSION,
    actionCycleId,
    resolvedProfileFingerprint: profile.resolvedFingerprint,
    readinessFingerprint: profile.componentFingerprints.readiness,
  };
}

const CROSSWORD_CYCLE = cycle('b2b4-cycle-crossword');

function evidenceAll(
  overrides: Readonly<Record<string, CrosswordEvidenceAvailability>> = {},
): CrosswordEvidenceFact[] {
  return profile.requiredAuthoritativeEvidence.map((evidenceId) => ({
    evidenceId,
    availability: overrides[evidenceId] ?? 'authoritative',
  }));
}

// ── Real accepted generator / execution fixtures (WP5 Slice 5-E) ─────────────

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
    targetGeometry: { id: createdTargetId, x: 10, y: 20, width: 40, height: 40 },
    raster: generatedVectorRaster({ id: createdTargetId, rendererFingerprint, rasterFingerprint }),
    observationId: `obs-${executionRole}`,
    tornRecaptureCount: 0,
    contextClosed: true,
    ...remaining,
  };
}

function executionSet(
  seeds: readonly [number, number, number],
  words: readonly string[] = WORDS,
): CrosswordOracleInput {
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

const PASS_SET = executionSet([SEED_A, SEED_A, SEED_B]);

// ── Adapter invocation helpers ───────────────────────────────────────────────

function observationOf(input: CrosswordOracleInput): CrosswordLiveEvaluationObservation {
  const evaluation = evaluateCrosswordOracle(input);
  return {
    primitiveFacts: evaluation.primitiveFacts,
    comparison: evaluation.comparison,
    diagnostics: evaluation.diagnostics,
  };
}

type AdapterInput = Parameters<typeof adaptCrosswordLiveFacts>[0];

function crosswordInput(
  input: CrosswordOracleInput,
  overrides: Partial<AdapterInput> = {},
): AdapterInput {
  return {
    envelope: crosswordCase.envelope,
    route: crosswordCase.route,
    actionCycle: CROSSWORD_CYCLE,
    clock: input.clock,
    sourceFingerprintExpected: input.sourceFingerprintExpected,
    executions: input.executions,
    oracle: observationOf(input),
    evidence: evidenceAll(),
    ...overrides,
  };
}

function issueCodes(failure: CrosswordLiveFactFailure): string[] {
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

const CHECK_IDS = [
  'crossword.created',
  'crossword.different-seed-sensitive',
  'crossword.raster-current',
  'crossword.same-seed-repeatable',
  'crossword.seed-derived',
  'crossword.semantic-valid',
];

/** The delivered Oracle's own check order (catalogue order), not the kernel's. */
const ORACLE_CHECK_ORDER = [
  'crossword.created',
  'crossword.seed-derived',
  'crossword.semantic-valid',
  'crossword.same-seed-repeatable',
  'crossword.different-seed-sensitive',
  'crossword.raster-current',
];

const EVIDENCE_BY_CHECK: Readonly<Record<string, string[]>> = Object.fromEntries(
  profile.requiredChecks.map((contract) => [
    contract.checkId,
    [...contract.requiredEvidence].sort(),
  ]),
);

// ── Envelope agreement and fail-closed adaptation ───────────────────────────

describe('[P7-B2-B4] exact-envelope agreement and fail-closed adaptation', () => {
  it('adapts the real representative Crossword envelope into complete structured facts', () => {
    const adaptation = adaptCrosswordLiveFacts(crosswordInput(PASS_SET));
    expect(adaptation.ok).toBe(true);
    if (!adaptation.ok) return;
    expect(adaptation.facts.evaluator).toBe('crossword-determinism');
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
    expect(adaptation.facts.oracleFacts).not.toBeNull();
    expect(adaptation.facts.oracleFacts?.comparison).toMatchObject({
      sameSeedPair: true,
      differentSeedPair: true,
      repeatIdentical: true,
      seedSensitivity: true,
      collision: false,
      wordsEqualAcrossChildren: true,
      distinctDocuments: true,
    });
    expect(adaptation.facts.oracleFacts?.clockEpochs).toEqual([SEED_A, SEED_A, SEED_B]);
    expect(adaptation.facts.oracleFacts?.currentnessDistinct).toBe(true);
    expect(adaptation.facts.oracleFacts?.rasterCurrent).toBe(true);
    expect(Object.hasOwn(adaptation.facts, 'harnessInvalid')).toBe(false);
    expect(adaptation.facts.clock).toBe(PASS_SET.clock);
    expect(adaptation.facts.executions).toBe(PASS_SET.executions);
  });

  it('fails closed before the kernel on every envelope disagreement class', () => {
    const planFingerprint = adaptCrosswordLiveFacts({
      ...crosswordInput(PASS_SET),
      envelope: {
        ...crosswordCase.envelope,
        planFingerprint: 'f'.repeat(64),
      } as MaterializedExecutionEnvelopeV1,
    });
    expect(planFingerprint.ok).toBe(false);
    if (!planFingerprint.ok) {
      expect(planFingerprint.status).toBe('HARNESS_BLOCKED');
      expect(planFingerprint.launchAttempted).toBe(false);
      expect(issueCodes(planFingerprint)).toContain('ENVELOPE_PLAN_FINGERPRINT_MISMATCH');
    }

    const caseId = adaptCrosswordLiveFacts({
      ...crosswordInput(PASS_SET),
      envelope: {
        ...crosswordCase.envelope,
        caseId: 'other-case',
      } as MaterializedExecutionEnvelopeV1,
    });
    expect(caseId.ok).toBe(false);

    const routeMismatch = adaptCrosswordLiveFacts({
      ...crosswordInput(PASS_SET),
      route: { ...crosswordCase.route, variant: 'foreign-variant' },
    });
    expect(routeMismatch.ok).toBe(false);
    if (!routeMismatch.ok) {
      expect(issueCodes(routeMismatch)).toContain('ENVELOPE_ROUTE_MISMATCH');
    }

    const evaluatorMismatch = adaptCrosswordLiveFacts({
      ...crosswordInput(PASS_SET),
      envelope: {
        ...crosswordCase.envelope,
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

    const actionCycleMismatch = adaptCrosswordLiveFacts({
      ...crosswordInput(PASS_SET),
      actionCycle: { ...CROSSWORD_CYCLE, resolvedProfileFingerprint: 'a'.repeat(64) },
    });
    expect(actionCycleMismatch.ok).toBe(false);
    if (!actionCycleMismatch.ok) {
      expect(issueCodes(actionCycleMismatch)).toContain('ENVELOPE_ACTION_CYCLE_MISMATCH');
    }

    const readinessMismatch = adaptCrosswordLiveFacts({
      ...crosswordInput(PASS_SET),
      actionCycle: { ...CROSSWORD_CYCLE, readinessFingerprint: 'b'.repeat(64) },
    });
    expect(readinessMismatch.ok).toBe(false);
    if (!readinessMismatch.ok) {
      expect(issueCodes(readinessMismatch)).toContain('ENVELOPE_READINESS_MISMATCH');
    }

    const invalidEvidence = adaptCrosswordLiveFacts({
      ...crosswordInput(PASS_SET),
      evidence: [{ evidenceId: 'observation', availability: 'invented' } as never],
    });
    expect(invalidEvidence.ok).toBe(false);
    if (!invalidEvidence.ok) {
      expect(issueCodes(invalidEvidence)).toContain('CROSSWORD_LIVE_EVIDENCE_FACT_INVALID');
    }

    const malformedObservation = adaptCrosswordLiveFacts({
      ...crosswordInput(PASS_SET),
      oracle: {
        primitiveFacts: { authority: 'current' },
      } as unknown as CrosswordLiveEvaluationObservation,
    });
    expect(malformedObservation.ok).toBe(false);
    if (!malformedObservation.ok) {
      expect(issueCodes(malformedObservation)).toContain('CROSSWORD_LIVE_OBSERVATION_MALFORMED');
    }

    const unknownIssueCodes = new Set<string>(CROSSWORD_LIVE_FACT_ISSUE_CODES);
    for (const failure of [planFingerprint, routeMismatch, actionCycleMismatch, invalidEvidence]) {
      if (failure.ok) continue;
      for (const issue of failure.issues) {
        expect(unknownIssueCodes.has(issue.code)).toBe(true);
      }
    }
  });

  it('never invokes the kernel on a disagreeing envelope', () => {
    const failed = evaluateCrosswordLiveChecks({
      ...crosswordInput(PASS_SET),
      actionCycle: { ...CROSSWORD_CYCLE, resolvedProfileFingerprint: 'c'.repeat(64) },
    });
    expect(failed.ok).toBe(false);
    expect(Object.hasOwn(failed, 'result')).toBe(false);
    expect(Object.hasOwn(failed, 'facts')).toBe(false);
  });
});

// ── Crossword live-fact behavior ────────────────────────────────────────────

describe('[P7-B2-B4] Crossword live facts', () => {
  it('produces complete PASS checks with identity/evidence agreement', () => {
    const outcome = evaluateCrosswordLiveChecks(crosswordInput(PASS_SET));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.checks.map((check) => check.checkId)).toEqual(CHECK_IDS);
    for (const check of outcome.result.checks) {
      expect(check.status).toBe('PASS');
      expect(check.actual.authority).toBe('current');
      expect(check.evidenceIds).toEqual(EVIDENCE_BY_CHECK[check.checkId]);
    }
    assertIdentityAgreement(outcome.result.checks, CROSSWORD_CYCLE);
  });

  it('fails only different-seed-sensitive for the documented 2 ms seed collision', () => {
    const input = executionSet([SEED_A, SEED_A, SEED_COLLISION]);
    const evaluation = evaluateCrosswordOracle(input);
    expect(evaluation.harnessInvalid).toBe(false);
    expect(evaluation.comparison?.seedSensitivity).toBe(false);
    expect(evaluation.primitiveFacts.comparison?.collision).toBe(true);
    expect(evaluation.primitiveFacts.comparison?.seedSensitivity).toBe(false);

    const outcome = evaluateCrosswordLiveChecks(crosswordInput(input));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(statusFor(outcome.result.checks, 'crossword.different-seed-sensitive')).toBe('FAIL');
    for (const checkId of [
      'crossword.created',
      'crossword.raster-current',
      'crossword.same-seed-repeatable',
      'crossword.seed-derived',
      'crossword.semantic-valid',
    ]) {
      expect(statusFor(outcome.result.checks, checkId)).toBe('PASS');
    }
    const failed = checkFor(outcome.result.checks, 'crossword.different-seed-sensitive');
    expect(failed?.actual.authority).toBe('current');
    expect(diagnosticCodesOf(failed)).toContain('PRODUCT_CROSSWORD_SEED_INSENSITIVE');
    assertIdentityAgreement(outcome.result.checks, CROSSWORD_CYCLE);
  });

  it('fails only same-seed-repeatable when A2 diverges at the same clock baseline', () => {
    const input = executionSet([SEED_A, SEED_A, SEED_B]);
    (input.executions as unknown[])[1] = executionChild('A2', SEED_A, { layoutSeed: SEED_B });
    const outcome = evaluateCrosswordLiveChecks(crosswordInput(input));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(statusFor(outcome.result.checks, 'crossword.same-seed-repeatable')).toBe('FAIL');
    expect(statusFor(outcome.result.checks, 'crossword.different-seed-sensitive')).toBe('PASS');
    expect(
      checkFor(outcome.result.checks, 'crossword.same-seed-repeatable')?.actual.authority,
    ).toBe('current');
    assertIdentityAgreement(outcome.result.checks, CROSSWORD_CYCLE);
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
    const outcome = evaluateCrosswordLiveChecks(crosswordInput(input));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(statusFor(outcome.result.checks, 'crossword.raster-current')).toBe('FAIL');
    expect(statusFor(outcome.result.checks, 'crossword.created')).toBe('PASS');
    expect(
      diagnosticCodesOf(checkFor(outcome.result.checks, 'crossword.raster-current')),
    ).toContain('PRODUCT_CROSSWORD_RASTER_INVALID');
    assertIdentityAgreement(outcome.result.checks, CROSSWORD_CYCLE);
  });

  it('fails only semantic-valid for a coherent non-default word set at every child', () => {
    const input = executionSet([SEED_A, SEED_A, SEED_B], ['MAKEIT', 'CROSSWORD']);
    const outcome = evaluateCrosswordLiveChecks(crosswordInput(input));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(statusFor(outcome.result.checks, 'crossword.semantic-valid')).toBe('FAIL');
    expect(statusFor(outcome.result.checks, 'crossword.created')).toBe('PASS');
    expect(statusFor(outcome.result.checks, 'crossword.raster-current')).toBe('PASS');
    assertIdentityAgreement(outcome.result.checks, CROSSWORD_CYCLE);
  });

  it('fails seed-derived for a current, interpretable wrong seed while authority stays current', () => {
    const input = executionSet([SEED_A, SEED_A, SEED_B]);
    const first = input.executions[0] as ReturnType<typeof executionChild>;
    (input.executions as unknown[])[0] = {
      ...first,
      actualSeed: SEED_A + 1,
      currentness: { ...first.currentness, generationSeed: SEED_A + 1 },
    };
    const outcome = evaluateCrosswordLiveChecks(crosswordInput(input));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(statusFor(outcome.result.checks, 'crossword.seed-derived')).toBe('FAIL');
    expect(statusFor(outcome.result.checks, 'crossword.raster-current')).toBe('PASS');
    expect(checkFor(outcome.result.checks, 'crossword.seed-derived')?.actual.authority).toBe(
      'current',
    );
    assertIdentityAgreement(outcome.result.checks, CROSSWORD_CYCLE);
  });

  it('produces UNUSABLE for missing/stale/torn/wrong-target/malformed/ambiguous authority', () => {
    const base = executionSet([SEED_A, SEED_A, SEED_B]);
    const first = () => structuredClone(base.executions[0]) as ReturnType<typeof executionChild>;

    const cases: readonly [string, CrosswordOracleInput, string][] = [
      ['no children', { ...base, executions: [] }, 'missing'],
      ['missing role', { ...base, executions: base.executions.slice(0, 2) }, 'missing'],
      ['source drift', { ...base, sourceFingerprintExpected: 'f'.repeat(64) }, 'stale'],
      [
        'pending raster',
        {
          ...base,
          executions: [
            { ...first(), raster: { ...first().raster, status: 'pending' } },
            ...base.executions.slice(1),
          ],
        },
        'stale',
      ],
      [
        'torn raster',
        {
          ...base,
          executions: [
            {
              ...first(),
              raster: { ...first().raster, status: 'torn', reason: 'observation-changed' },
            },
            ...base.executions.slice(1),
          ],
        },
        'torn',
      ],
      [
        'wrong-target raster',
        {
          ...base,
          executions: [
            { ...first(), raster: { ...first().raster, id: 'other-target' } },
            ...base.executions.slice(1),
          ],
        },
        'wrong-target',
      ],
      [
        'malformed raster arm',
        {
          ...base,
          executions: [
            { ...first(), raster: { ...first().raster, authorityKind: 'not-a-projection-arm' } },
            ...base.executions.slice(1),
          ],
        },
        'malformed',
      ],
      [
        'non-object child',
        { ...base, executions: [null, ...base.executions.slice(1)] },
        'malformed',
      ],
      [
        'reused document identity',
        { ...base, executions: [first(), { ...first(), executionRole: 'A2' }, base.executions[2]] },
        'ambiguous',
      ],
    ];

    for (const [label, input, expectedAuthority] of cases) {
      const outcome = evaluateCrosswordLiveChecks(crosswordInput(input));
      expect(outcome.ok, label).toBe(true);
      if (!outcome.ok) continue;
      expect(
        outcome.result.checks.map((check) => check.status),
        label,
      ).toEqual(CHECK_IDS.map(() => 'UNUSABLE'));
      for (const check of outcome.result.checks) {
        expect(check.actual.authority, label).toBe(expectedAuthority);
      }
    }
  });

  it('never lets a passing check rescue a failed one', () => {
    const outcome = evaluateCrosswordLiveChecks(
      crosswordInput(executionSet([SEED_A, SEED_A, SEED_COLLISION])),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(statusFor(outcome.result.checks, 'crossword.different-seed-sensitive')).toBe('FAIL');
    expect(statusFor(outcome.result.checks, 'crossword.semantic-valid')).toBe('PASS');
  });

  it('carries only trustworthy product warnings, never for unusable authority', () => {
    const collision = evaluateCrosswordLiveChecks(
      crosswordInput(executionSet([SEED_A, SEED_A, SEED_COLLISION])),
    );
    expect(collision.ok).toBe(true);
    if (collision.ok) {
      expect(checkFor(collision.result.checks, 'crossword.different-seed-sensitive')?.status).toBe(
        'FAIL',
      );
      expect(collision.result.issues.map((entry) => entry.code)).not.toContain(
        'CROSSWORD_KERNEL_EXECUTION_AUTHORITY_UNUSABLE',
      );
    }

    const torn = executionSet([SEED_A, SEED_A, SEED_B]);
    const child = structuredClone(torn.executions[0]) as ReturnType<typeof executionChild>;
    (torn.executions as unknown[])[0] = {
      ...child,
      raster: { ...child.raster, status: 'torn', reason: 'observation-changed' },
    };
    const unusable = evaluateCrosswordLiveChecks(crosswordInput(torn));
    expect(unusable.ok).toBe(true);
    if (unusable.ok) {
      const codes = checkFor(unusable.result.checks, 'crossword.raster-current')?.actual
        .diagnosticCodes as string[];
      expect(codes).toContain('CROSSWORD_RASTER_AUTHORITY_UNUSABLE');
      expect(codes).not.toContain('PRODUCT_CROSSWORD_RASTER_INVALID');
    }
  });

  it('passes the observed evidence roles through untouched and never invents a role', () => {
    const observed = evidenceAll();
    const outcome = evaluateCrosswordLiveChecks(crosswordInput(PASS_SET, { evidence: observed }));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.facts.evidence).toEqual(observed);
  });

  it('never lets a diagnostic evidence item rescue a required check', () => {
    const outcome = evaluateCrosswordLiveChecks(
      crosswordInput(PASS_SET, {
        evidence: evidenceAll({ 'raster.accepted': 'diagnostic-only' }),
      }),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(statusFor(outcome.result.checks, 'crossword.raster-current')).toBe('UNUSABLE');
    expect(statusFor(outcome.result.checks, 'crossword.semantic-valid')).toBe('PASS');
    expect(outcome.result.issues.map((entry) => entry.code)).toContain(
      'CROSSWORD_KERNEL_EVIDENCE_DIAGNOSTIC_ONLY',
    );

    const undeclared = evaluateCrosswordLiveChecks(
      crosswordInput(PASS_SET, {
        evidence: [
          ...evidenceAll(),
          { evidenceId: 'screenshot.diagnostic', availability: 'authoritative' },
        ],
      }),
    );
    expect(undeclared.ok).toBe(true);
    if (!undeclared.ok) return;
    expect(
      undeclared.result.checks.every(
        (check) => !check.evidenceIds.includes('screenshot.diagnostic'),
      ),
    ).toBe(true);
    expect(undeclared.result.issues.map((entry) => entry.code)).toContain(
      'CROSSWORD_KERNEL_EVIDENCE_UNDECLARED',
    );
  });

  it('carries no legacy harnessInvalid or boolean passed authority into the kernel facts', () => {
    const adaptation = adaptCrosswordLiveFacts(crosswordInput(PASS_SET));
    expect(adaptation.ok).toBe(true);
    if (!adaptation.ok) return;
    const facts = adaptation.facts as CrosswordKernelFacts;
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

describe('[P7-B2-B4] legacy authority elimination', () => {
  it('derives facts only from additive primitive observations, never from legacy booleans', () => {
    const baseline = evaluateCrosswordLiveChecks(crosswordInput(PASS_SET));
    expect(baseline.ok).toBe(true);
    if (!baseline.ok) return;
    expect(baseline.result.checks.every((check) => check.status === 'PASS')).toBe(true);

    // Flip every legacy composite check-result boolean and the aggregate
    // harness-validity flag while leaving the additive primitive facts
    // byte-identical. The adapter must not observe any difference.
    const evaluation = evaluateCrosswordOracle(PASS_SET);
    const flipped = {
      ...evaluation,
      checks: evaluation.checks.map((check) => ({ ...check, passed: !check.passed })),
      harnessInvalid: !evaluation.harnessInvalid,
    };
    const afterFlip = evaluateCrosswordLiveChecks(
      crosswordInput(PASS_SET, {
        oracle: {
          primitiveFacts: flipped.primitiveFacts,
          comparison: flipped.comparison,
          diagnostics: flipped.diagnostics,
        } as unknown as CrosswordLiveEvaluationObservation,
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
    const afterPrimitive = evaluateCrosswordLiveChecks(
      crosswordInput(PASS_SET, {
        oracle: {
          primitiveFacts: tamperedPrimitives,
          comparison: evaluation.comparison,
          diagnostics: evaluation.diagnostics,
        } as unknown as CrosswordLiveEvaluationObservation,
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
    const evaluation = evaluateCrosswordOracle(PASS_SET);
    expect(evaluation.harnessInvalid).toBe(false);
    const primitives = {
      ...evaluation.primitiveFacts,
      authority: 'malformed' as const,
      checks: evaluation.primitiveFacts.checks.map((check) => ({
        ...check,
        predicateMet: true,
      })),
    };
    const outcome = evaluateCrosswordLiveChecks(
      crosswordInput(PASS_SET, {
        oracle: {
          primitiveFacts: primitives,
          comparison: evaluation.comparison,
          diagnostics: evaluation.diagnostics,
        } as unknown as CrosswordLiveEvaluationObservation,
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

  it('emits no aggregate harnessInvalid and no boolean oracle authority in the result payload', () => {
    const outcome = evaluateCrosswordLiveChecks(crosswordInput(PASS_SET));
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
      expect(oracleFacts.sourceAgreement).toBe(true);
    }
  });

  it('preserves the active Oracle consumers additively', () => {
    const evaluation = evaluateCrosswordOracle(PASS_SET);
    // Legacy fields the active runtime still consumes remain exactly as before.
    expect(evaluation.checks.map((check) => check.checkId)).toEqual(ORACLE_CHECK_ORDER);
    expect(evaluation.checks.every((check) => check.passed)).toBe(true);
    expect(evaluation.harnessInvalid).toBe(false);
    expect(evaluation.diagnostics).toEqual([]);
    // The additive primitive facts carry only named primitives, never a boolean
    // check result or aggregate harness flag.
    expect(evaluation.primitiveFacts.authority).toBe('current');
    expect(evaluation.primitiveFacts.sourceAgreement).toBe(true);
    expect(evaluation.primitiveFacts.comparison).toMatchObject({
      sameSeedPair: true,
      differentSeedPair: true,
      repeatIdentical: true,
      seedSensitivity: true,
      collision: false,
      wordsEqualAcrossChildren: true,
      distinctDocuments: true,
    });
    expect(evaluation.primitiveFacts.clockEpochs).toEqual([SEED_A, SEED_A, SEED_B]);
    expect(evaluation.primitiveFacts.currentnessDistinct).toBe(true);
    expect(evaluation.primitiveFacts.rasterCurrent).toBe(true);
    expect(evaluation.primitiveFacts.checks.map((check) => check.checkId)).toEqual(
      ORACLE_CHECK_ORDER,
    );
    expect(Object.hasOwn(evaluation.primitiveFacts, 'passed')).toBe(false);
    expect(Object.hasOwn(evaluation.primitiveFacts, 'status')).toBe(false);
    expect(Object.hasOwn(evaluation.primitiveFacts, 'harnessInvalid')).toBe(false);
    for (const check of evaluation.primitiveFacts.checks) {
      expect(Object.hasOwn(check, 'passed')).toBe(false);
      expect(typeof check.predicateMet).toBe('boolean');
    }
    // The adapter's structured projection never carries the raw legacy booleans.
    const projected = projectCrosswordLiveFacts({
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

describe('[P7-B2-B4] inactive adapter invariants', () => {
  const source = (relative: string): string => readFileSync(path.join(skillRoot, relative), 'utf8');
  const adapterSource = source('src/adapters/crossword-live-facts.ts');
  const kernelSource = source('src/kernels/crossword-kernel.ts');

  it('does not import any active executor, Oracle, evidence writer, CLI, browser, or classifier', () => {
    expect(adapterSource).not.toMatch(
      /from '\.\.\/(runtime|oracles|evidence|cli|browser|workflows|commands)\//,
    );
    for (const token of [
      'execute-plan',
      'execute-crossword-plan',
      'evaluateCrosswordOracle',
      'writeRunRecord',
      'outcomes',
      'contracts/execution',
    ]) {
      expect(adapterSource, token).not.toContain(token);
    }
  });

  it('owns no required-check array, fallback id, deadline, tolerance, visual, or normalization literal', () => {
    for (const token of [
      "'crossword.created'",
      "'crossword.seed-derived'",
      "'crossword.semantic-valid'",
      "'crossword.same-seed-repeatable'",
      "'crossword.different-seed-sensitive'",
      "'crossword.raster-current'",
      "'crossword-determinism-v1'",
      "'layer/crossword'",
      'deadlineMs',
      'stableFrames',
      'quiescenceRequired',
      '8000',
      'RENDER_TRANSFORM_CSS_TOLERANCE_PX',
    ]) {
      expect(adapterSource, token).not.toContain(token);
    }
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
    expect(kernelSource).not.toContain('CROSSWORD_KERNEL_HARNESS_INVALID');
  });

  it('is inactive: not exported from the public barrel and unreferenced by active modules', () => {
    const indexSource = source('src/index.ts');
    expect(indexSource).not.toContain('crossword-live-facts');
    expect(indexSource).not.toContain('adaptCrosswordLiveFacts');
    expect(indexSource).not.toContain('evaluateCrosswordLiveChecks');
  });

  it('fails closed with a structured diagnostic on every reported issue', () => {
    const failure = adaptCrosswordLiveFacts({
      ...crosswordInput(PASS_SET),
      evidence: [{ evidenceId: 'x', availability: 'nope' } as never],
    });
    expect(failure.ok).toBe(false);
    if (failure.ok) return;
    expect(failure.status).toBe('HARNESS_BLOCKED');
    expect(failure.launchAttempted).toBe(false);
    expect(failure.diagnostic.code).toBe('UNUSABLE_EVIDENCE');
    expect(failure.diagnostic.detail).toContain('CROSSWORD_LIVE_EVIDENCE_FACT_INVALID');
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

describe('[P7-B2-B4] compiled compatibility mutation matrix', () => {
  const leafPaths: string[] = [];
  collectLeafPaths(profile, '', leafPaths);
  const baseInput = crosswordInput(PASS_SET);

  it('covers the complete compiled Crossword profile projection', () => {
    expect(leafPaths.length).toBeGreaterThanOrEqual(150);
  });

  it('detects every single-leaf mutation of the compiled Crossword profile', () => {
    for (const leafPath of leafPaths) {
      const adaptation = adaptCrosswordLiveFacts({
        ...baseInput,
        envelope: mutatedEnvelope(crosswordCase.envelope, leafPath),
      });
      expect(adaptation.ok, `mutation of ${leafPath} was not detected`).toBe(false);
    }
  });

  it('detects a mutated component fingerprint retained against the stored resolved identity', () => {
    const clone = structuredClone(profile) as unknown as Record<string, unknown>;
    (clone.componentFingerprints as Record<string, unknown>).oracle = 'c'.repeat(64);
    const adaptation = adaptCrosswordLiveFacts({
      ...baseInput,
      envelope: {
        ...crosswordCase.envelope,
        correctnessProfile: clone,
      } as unknown as MaterializedExecutionEnvelopeV1,
    });
    expect(adaptation.ok).toBe(false);
  });

  it('keeps an unrelated valid envelope accepted after the mutation matrix', () => {
    const adaptation = adaptCrosswordLiveFacts(baseInput);
    expect(adaptation.ok).toBe(true);
    if (adaptation.ok) {
      expect(adaptation.facts.oracleFacts).not.toBeNull();
      expect(adaptation.facts.checks).toHaveLength(CHECK_IDS.length);
      expect(isFullCanonicalFingerprint(profile.resolvedFingerprint)).toBe(true);
    }
  });
});
