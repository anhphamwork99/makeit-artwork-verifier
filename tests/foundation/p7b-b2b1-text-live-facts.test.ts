import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadCatalogueBundle, type CatalogueBundle } from '../../src/catalogue/load';
import { loadDiagnosticSuite, resolveSuiteRequests } from '../../src/catalogue/suite';
import type { MaterializedCase } from '../../src/contracts/case-model';
import type { ResolvedCorrectnessProfile } from '../../src/contracts/correctness';
import {
  applyAffine,
  circleControlBounds,
  computeCircleWarpFingerprint,
  computeRepresentationFingerprint,
  scaleAffine,
  translationAffine,
  type Affine2D,
  type CircleWarpPayloadInput,
  type Quad,
  type TypedGeometryResult,
} from '../../src/contracts/geometry-v2';
import { CHECK_RESULT_CONTRACT_SCHEMA_VERSION } from '../../src/contracts/schema-versions';
import { evaluateGeometryDeltaOracle } from '../../src/oracles/geometry';
import {
  evaluateWarpedTextOracle,
  type WarpedTextOracleInput,
} from '../../src/oracles/warped-text';
import {
  MATERIALIZED_EXECUTION_ENVELOPE_SCHEMA_VERSION,
  type MaterializedExecutionEnvelopeV1,
} from '../../src/planner/execution-materialization';
import { planCaseForExecution } from '../../src/planner/plan-case';
import { resolveToolkitRoot } from '../../src/runtime/paths';
import {
  TEXT_LIVE_FACT_ISSUE_CODES,
  adaptOrdinaryTextLiveFacts,
  adaptWarpedTextLiveFacts,
  evaluateOrdinaryTextLiveChecks,
  evaluateWarpedTextLiveChecks,
  type OrdinaryTextLiveDeltaObservation,
  type TextLiveFactFailure,
  type TextLiveFactRoute,
} from '../../src/adapters/text-live-facts';
import {
  isFullCanonicalFingerprint,
  projectCorrectnessProfileIdentity,
  validateResultIdentityAgreement,
} from '../../src/index';
import type {
  ActionCycleCorrectnessIdentity,
  CorrectnessCheckResult,
  OrdinaryTextKernelFacts,
  TextEvidenceAvailability,
  TextEvidenceFact,
  WarpedTextKernelFacts,
} from '../../src/index';

/**
 * P7-B2-B1 focused proof: inactive live-fact adapters for ordinary and
 * circle-warped Text (ADR 0029 §4 B2-B).
 *
 * The suites drive the adapters from the *real* exact envelopes produced by
 * `planCaseForExecution` for the two representative Text requests and the
 * *real* accepted Text/warped Oracle outputs. They cover PASS, product
 * mismatch, missing, stale, torn, and ambiguous authority; identity/evidence
 * agreement; fail-closed envelope rejection before the kernel; no adapter
 * policy; no active imports; no legacy boolean/harnessInvalid authority in the
 * produced structured facts; and a single-leaf mutation of every compiled
 * compatibility field.
 */

const skillRoot = resolveToolkitRoot();
const bundle: CatalogueBundle = loadCatalogueBundle();

function representativeRequest(fileName: string): unknown {
  const resolved = resolveSuiteRequests(loadDiagnosticSuite('representative'));
  const entry = resolved.find((candidate) => path.basename(candidate.relativePath) === fileName);
  if (entry === undefined) throw new Error(`missing representative request ${fileName}`);
  return entry.request;
}

const ORDINARY_REQUEST = 'layer-text-move-drag-ordinary.json';
const WARPED_REQUEST = 'layer-text-move-drag-warped-nested.json';

interface PreparedCase {
  readonly envelope: MaterializedExecutionEnvelopeV1;
  readonly profile: ResolvedCorrectnessProfile;
  readonly route: TextLiveFactRoute;
  readonly minimumDelta: { readonly x: number; readonly y: number };
  readonly case: MaterializedCase;
}

function prepare(fileName: string): PreparedCase {
  const result = planCaseForExecution(representativeRequest(fileName), { catalogues: bundle });
  if (result.status !== 'PLANNED') throw new Error(`${fileName} did not plan: ${result.status}`);
  if (result.envelope === null) throw new Error(`${fileName} produced no envelope`);
  const envelope = result.envelope;
  const intent = result.materializedCase.intent;
  const expected = intent.expected as { minimumDelta?: { x: number; y: number } };
  if (expected.minimumDelta === undefined) throw new Error('missing minimumDelta');
  expect(envelope.schemaVersion).toBe(MATERIALIZED_EXECUTION_ENVELOPE_SCHEMA_VERSION);
  return {
    envelope,
    profile: envelope.correctnessProfile as unknown as ResolvedCorrectnessProfile,
    route: {
      subjectId: intent.subjectId,
      capability: intent.capability,
      variant: intent.variant,
    },
    minimumDelta: expected.minimumDelta,
    case: result.materializedCase,
  };
}

const ordinaryCase = prepare(ORDINARY_REQUEST);
const warpedCase = prepare(WARPED_REQUEST);

function cycle(prepared: PreparedCase, actionCycleId: string): ActionCycleCorrectnessIdentity {
  return {
    schemaVersion: CHECK_RESULT_CONTRACT_SCHEMA_VERSION,
    actionCycleId,
    resolvedProfileFingerprint: prepared.profile.resolvedFingerprint,
    readinessFingerprint: prepared.profile.componentFingerprints.readiness,
  };
}

const ORDINARY_CYCLE = cycle(ordinaryCase, 'b2b1-cycle-ordinary');
const WARPED_CYCLE = cycle(warpedCase, 'b2b1-cycle-warped');

function evidenceAll(
  profile: ResolvedCorrectnessProfile,
  overrides: Readonly<Record<string, TextEvidenceAvailability>> = {},
): TextEvidenceFact[] {
  return profile.requiredAuthoritativeEvidence.map((evidenceId) => ({
    evidenceId,
    availability: overrides[evidenceId] ?? 'authoritative',
  }));
}

// ── Real ordinary-Text Oracle facts ─────────────────────────────────────────

function ordinaryPassingObservation(): OrdinaryTextLiveDeltaObservation {
  return evaluateGeometryDeltaOracle({
    minimumDelta: { x: 40, y: 20 },
    canonicalBefore: { x: 100, y: 100 },
    canonicalAfter: { x: 150, y: 130 },
    renderedBefore: { x: 100, y: 100 },
    renderedAfter: { x: 150, y: 130 },
  });
}

function ordinaryMismatchObservation(): OrdinaryTextLiveDeltaObservation {
  return evaluateGeometryDeltaOracle({
    minimumDelta: { x: 40, y: 20 },
    canonicalBefore: { x: 100, y: 100 },
    canonicalAfter: { x: 110, y: 105 },
    renderedBefore: { x: 100, y: 100 },
    renderedAfter: { x: 110, y: 105 },
  });
}

function ordinaryUnusableObservation(): OrdinaryTextLiveDeltaObservation {
  return evaluateGeometryDeltaOracle({
    minimumDelta: { x: 40, y: 20 },
    canonicalBefore: { x: 100, y: 100 },
    canonicalAfter: { x: 150, y: 130 },
    renderedBefore: { x: 100, y: 100 },
    renderedAfter: null,
  });
}

// ── Real warped-Text Oracle facts (WP5 Slice 5-B fixture) ────────────────────

const WARPED_PADDING = 14;
const WARPED_LAYOUT_ID = 'layout-a';
const WARPED_TARGET_ID = 'layout-a-text-1';
const WARPED_PAYLOAD: CircleWarpPayloadInput = {
  centerX: 99,
  centerY: 99,
  radius: 99,
  radiusY: 99,
  rotationAngle: -Math.PI / 2,
  arcLength: 0,
  inverted: false,
  verticalAlign: 'center',
  arcAlign: 'end',
};

function warpedSnapshot(layers: unknown[]): unknown {
  return [
    {
      id: WARPED_LAYOUT_ID,
      name: 'Layout A',
      xCoordinate: 120,
      yCoordinate: 90,
      width: 500,
      height: 500,
      zCoordinate: 1,
      layers,
    },
  ];
}

function warpedCanonicalLayer(position: { x: number; y: number }, payload = WARPED_PAYLOAD) {
  return {
    id: WARPED_TARGET_ID,
    type: 'TEXT',
    xCoordinate: position.x,
    yCoordinate: position.y,
    rotation: 0,
    transform: { flipX: false, flipY: false },
    warp: { type: 'circle', payload },
  };
}

function warpedRawQuad(payload: CircleWarpPayloadInput): Quad {
  const bounds = circleControlBounds(payload);
  if (bounds === null) throw new Error('bounds unavailable');
  return [
    { x: bounds.left, y: bounds.top },
    { x: bounds.right, y: bounds.top },
    { x: bounds.right, y: bounds.bottom },
    { x: bounds.left, y: bounds.bottom },
  ];
}

function warpedTransform(quad: Quad, matrix: Affine2D): Quad {
  return [
    applyAffine(matrix, quad[0]),
    applyAffine(matrix, quad[1]),
    applyAffine(matrix, quad[2]),
    applyAffine(matrix, quad[3]),
  ];
}

/** A consistent typed geometry record for one canonical layer position. */
function warpedRendererView(options: {
  position: { x: number; y: number };
  pointDeviationCss?: number;
}): TypedGeometryResult {
  const payload = WARPED_PAYLOAD;
  const position = options.position;
  const bounds = circleControlBounds(payload);
  if (bounds === null) throw new Error('bounds unavailable');
  const warpControlLocal = warpedRawQuad(payload);
  const frameWidth = bounds.width + WARPED_PADDING * 2;
  const frameHeight = bounds.height + WARPED_PADDING * 2;
  const translateIntoFrame = translationAffine(
    WARPED_PADDING - bounds.x,
    WARPED_PADDING - bounds.y,
  );
  const warpControlToSubjectFrame = translateIntoFrame;
  const subjectFrameLocal = warpedTransform(warpControlLocal, warpControlToSubjectFrame);
  const subjectFrameToLayout = translationAffine(
    position.x - WARPED_PADDING,
    position.y - WARPED_PADDING,
  );
  const layoutLocal = warpedTransform(subjectFrameLocal, subjectFrameToLayout);
  const layoutToWorldScene = translationAffine(120, 90);
  const worldSceneToStageViewportCss = scaleAffine(1, 1);
  const stageViewportToBrowserClientCss = translationAffine(20, 10);
  const worldScene = warpedTransform(layoutLocal, layoutToWorldScene);
  const stageViewportCss = warpedTransform(worldScene, worldSceneToStageViewportCss);
  let browserClientCss = warpedTransform(stageViewportCss, stageViewportToBrowserClientCss);
  if (options.pointDeviationCss) {
    browserClientCss = [
      browserClientCss[0],
      browserClientCss[1],
      { x: browserClientCss[2].x + options.pointDeviationCss, y: browserClientCss[2].y },
      browserClientCss[3],
    ];
  }
  const matrices = {
    warpControlToSubjectFrame,
    subjectFrameToLayout,
    layoutToWorldScene,
    worldSceneToStageViewportCss,
    stageViewportToBrowserClientCss,
  };
  const warpFingerprint = computeCircleWarpFingerprint(payload);
  const representationWithoutFingerprints = {
    kind: 'circle-control-envelope-quad-v1' as const,
    pointOrder: ['top-left', 'top-right', 'bottom-right', 'bottom-left'] as const,
    warpType: 'circle' as const,
    units: {
      warpControlLocal: 'artwork-unit',
      subjectFrameLocal: 'artwork-unit',
      layoutLocal: 'artwork-unit',
      worldScene: 'scene-unit',
      stageViewportCss: 'css-px',
      browserClientCss: 'css-px',
    },
    projection: {
      kind: 'circle-text-frame-projection-v1' as const,
      padding: {
        left: WARPED_PADDING,
        right: WARPED_PADDING,
        top: WARPED_PADDING,
        bottom: WARPED_PADDING,
      },
      controlBounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
      subjectFrame: {
        width: frameWidth,
        height: frameHeight,
        flipCenterX: frameWidth / 2,
        flipCenterY: frameHeight / 2,
      },
      flips: { x: false, y: false },
    },
    warpControlLocal,
    subjectFrameLocal,
    layoutLocal,
    worldScene,
    stageViewportCss,
    browserClientCss,
    matrices,
  } satisfies Omit<
    import('../../src/contracts/geometry-v2').CircleControlEnvelopeQuadV1,
    'representationFingerprint' | 'warpFingerprint'
  >;
  const representationFingerprint = computeRepresentationFingerprint({
    representation: representationWithoutFingerprints,
    targetId: WARPED_TARGET_ID,
    layoutId: WARPED_LAYOUT_ID,
    cssRatios: { x: 1, y: 1 },
    bridgeGeneration: 1,
    warpFingerprint,
  });
  return {
    schemaVersion: 2,
    typedProvenance: {
      schemaVersion: 2,
      bridgeGeneration: 1,
      stageFingerprint: 'stage',
      target: {
        id: WARPED_TARGET_ID,
        konvaId: WARPED_TARGET_ID,
        nodeClass: 'Group',
        subjectFrameToLayout,
        fingerprint: 'target',
      },
      layout: {
        id: WARPED_LAYOUT_ID,
        konvaId: `layout-${WARPED_LAYOUT_ID}`,
        nodeClass: 'Group',
        layoutToWorldScene,
        fingerprint: 'layout',
      },
      representationFingerprint,
    },
    representation: {
      ...representationWithoutFingerprints,
      warpFingerprint,
      representationFingerprint,
    },
    cssRatios: { x: 1, y: 1 },
  };
}

function warpedOracleInput(
  beforePosition = { x: 125, y: 125 },
  afterPosition = { x: 205, y: 165 },
  afterDeviationCss = 0,
): WarpedTextOracleInput {
  return {
    minimumDelta: { x: 40, y: 20 },
    targetId: WARPED_TARGET_ID,
    expectedLayoutId: WARPED_LAYOUT_ID,
    baseline: {
      layoutItems: warpedSnapshot([warpedCanonicalLayer(beforePosition)]),
      geometryV2: warpedRendererView({ position: beforePosition }),
    },
    observed: {
      layoutItems: warpedSnapshot([warpedCanonicalLayer(afterPosition)]),
      geometryV2: warpedRendererView({
        position: afterPosition,
        pointDeviationCss: afterDeviationCss,
      }),
    },
  };
}

function warpedPassing() {
  return evaluateWarpedTextOracle(warpedOracleInput());
}

function warpedMismatch() {
  return evaluateWarpedTextOracle(warpedOracleInput(undefined, undefined, 5));
}

function warpedHarnessInvalid() {
  const input = warpedOracleInput();
  return evaluateWarpedTextOracle({
    ...input,
    baseline: { layoutItems: input.baseline.layoutItems, geometryV2: null },
  });
}

// ── Envelope agreement and fail-closed adaptation ───────────────────────────

function issueCodes(failure: TextLiveFactFailure): string[] {
  return failure.issues.map((issue) => issue.code);
}

function cloneProfile(profile: ResolvedCorrectnessProfile): ResolvedCorrectnessProfile {
  return structuredClone(profile) as unknown as ResolvedCorrectnessProfile;
}

describe('[P7-B2-B1] exact-envelope agreement and fail-closed adaptation', () => {
  it('adapts both real representative Text envelopes into complete structured facts', () => {
    const ordinary = adaptOrdinaryTextLiveFacts({
      envelope: ordinaryCase.envelope,
      route: ordinaryCase.route,
      actionCycle: ORDINARY_CYCLE,
      minimumDelta: ordinaryCase.minimumDelta,
      delta: ordinaryPassingObservation(),
      evidence: evidenceAll(ordinaryCase.profile),
    });
    expect(ordinary.ok).toBe(true);
    if (!ordinary.ok) return;
    expect(ordinary.facts).toMatchObject({
      evaluator: 'canonical-delta',
      minimumDelta: { x: 40, y: 20 },
    });
    expect(ordinary.facts.check?.authority).toBe('current');
    expect(ordinary.facts.check?.mismatch).toBe(false);
    expect(Object.hasOwn(ordinary.facts.check as object, 'status')).toBe(false);
    expect(Object.hasOwn(ordinary.facts.check as object, 'passed')).toBe(false);

    const warped = adaptWarpedTextLiveFacts({
      envelope: warpedCase.envelope,
      route: warpedCase.route,
      actionCycle: WARPED_CYCLE,
      minimumDelta: warpedCase.minimumDelta,
      oracle: warpedPassing(),
      evidence: evidenceAll(warpedCase.profile),
    });
    expect(warped.ok).toBe(true);
    if (!warped.ok) return;
    expect(warped.facts.evaluator).toBe('typed-envelope');
    expect(warped.facts.checks.map((entry) => entry.checkId)).toEqual([
      'geometry.delta',
      'geometry.warp-envelope',
    ]);
    for (const entry of warped.facts.checks) {
      expect(entry.authority).toBe('current');
      expect(entry.currentness).toBe('current');
      expect(entry.mismatch).toBe(false);
      expect(Object.hasOwn(entry, 'passed')).toBe(false);
    }
    expect(Object.hasOwn(warped.facts, 'harnessInvalid')).toBe(false);
    expect(Object.hasOwn(warped.facts, 'requiredSourcesAgree')).toBe(false);
  });

  it('fails closed before the kernel on every envelope disagreement class', () => {
    const base = {
      envelope: ordinaryCase.envelope,
      route: ordinaryCase.route,
      actionCycle: ORDINARY_CYCLE,
      minimumDelta: ordinaryCase.minimumDelta,
      delta: ordinaryPassingObservation(),
      evidence: evidenceAll(ordinaryCase.profile),
    };

    const planFingerprint = adaptOrdinaryTextLiveFacts({
      ...base,
      envelope: {
        ...ordinaryCase.envelope,
        planFingerprint: 'f'.repeat(64),
      } as MaterializedExecutionEnvelopeV1,
    });
    expect(planFingerprint.ok).toBe(false);
    if (!planFingerprint.ok) {
      expect(planFingerprint.status).toBe('HARNESS_BLOCKED');
      expect(planFingerprint.launchAttempted).toBe(false);
      expect(issueCodes(planFingerprint)).toContain('ENVELOPE_PLAN_FINGERPRINT_MISMATCH');
    }

    const caseId = adaptOrdinaryTextLiveFacts({
      ...base,
      envelope: {
        ...ordinaryCase.envelope,
        caseId: 'other-case',
      } as MaterializedExecutionEnvelopeV1,
    });
    expect(caseId.ok).toBe(false);

    const routeMismatch = adaptOrdinaryTextLiveFacts({ ...base, route: warpedCase.route });
    expect(routeMismatch.ok).toBe(false);
    if (!routeMismatch.ok) {
      expect(issueCodes(routeMismatch)).toContain('ENVELOPE_ROUTE_MISMATCH');
    }

    const evaluatorMismatch = adaptOrdinaryTextLiveFacts({
      ...base,
      envelope: warpedCase.envelope,
      route: warpedCase.route,
      actionCycle: cycle(warpedCase, 'b2b1-cycle-ordinary'),
    });
    expect(evaluatorMismatch.ok).toBe(false);

    const actionCycleMismatch = adaptOrdinaryTextLiveFacts({
      ...base,
      actionCycle: { ...ORDINARY_CYCLE, resolvedProfileFingerprint: 'a'.repeat(64) },
    });
    expect(actionCycleMismatch.ok).toBe(false);
    if (!actionCycleMismatch.ok) {
      expect(issueCodes(actionCycleMismatch)).toContain('ENVELOPE_ACTION_CYCLE_MISMATCH');
    }

    const readinessMismatch = adaptOrdinaryTextLiveFacts({
      ...base,
      actionCycle: { ...ORDINARY_CYCLE, readinessFingerprint: 'b'.repeat(64) },
    });
    expect(readinessMismatch.ok).toBe(false);
    if (!readinessMismatch.ok) {
      expect(issueCodes(readinessMismatch)).toContain('ENVELOPE_READINESS_MISMATCH');
    }

    const invalidEvidence = adaptOrdinaryTextLiveFacts({
      ...base,
      evidence: [{ evidenceId: 'geometry.canonical', availability: 'invented' } as never],
    });
    expect(invalidEvidence.ok).toBe(false);
    if (!invalidEvidence.ok) {
      expect(issueCodes(invalidEvidence)).toContain('TEXT_LIVE_EVIDENCE_FACT_INVALID');
    }

    const malformedObservation = adaptOrdinaryTextLiveFacts({
      ...base,
      delta: { checkId: 'geometry.delta' } as unknown as OrdinaryTextLiveDeltaObservation,
    });
    expect(malformedObservation.ok).toBe(false);
    if (!malformedObservation.ok) {
      expect(issueCodes(malformedObservation)).toContain('TEXT_LIVE_OBSERVATION_MALFORMED');
    }

    const warpedBase = {
      envelope: warpedCase.envelope,
      route: warpedCase.route,
      actionCycle: WARPED_CYCLE,
      minimumDelta: warpedCase.minimumDelta,
      oracle: warpedPassing(),
      evidence: evidenceAll(warpedCase.profile),
    };
    const wrongOracleProfile = adaptWarpedTextLiveFacts({
      ...warpedBase,
      oracle: { ...warpedPassing(), profileId: 'foreign-oracle-v1' },
    });
    expect(wrongOracleProfile.ok).toBe(false);
    if (!wrongOracleProfile.ok) {
      expect(issueCodes(wrongOracleProfile)).toContain('TEXT_LIVE_OBSERVATION_PROFILE_MISMATCH');
    }

    const unknownIssueCodes = new Set<string>(TEXT_LIVE_FACT_ISSUE_CODES);
    for (const failure of [planFingerprint, routeMismatch, actionCycleMismatch, invalidEvidence]) {
      if (failure.ok) continue;
      for (const issue of failure.issues) {
        expect(unknownIssueCodes.has(issue.code)).toBe(true);
      }
      expect(isFullCanonicalFingerprint('f'.repeat(64))).toBe(true);
    }
  });

  it('never invokes the kernel on a disagreeing envelope', () => {
    const failed = evaluateOrdinaryTextLiveChecks({
      envelope: ordinaryCase.envelope,
      route: ordinaryCase.route,
      actionCycle: { ...ORDINARY_CYCLE, resolvedProfileFingerprint: 'c'.repeat(64) },
      minimumDelta: ordinaryCase.minimumDelta,
      delta: ordinaryPassingObservation(),
      evidence: evidenceAll(ordinaryCase.profile),
    });
    expect(failed.ok).toBe(false);
    expect(Object.hasOwn(failed, 'result')).toBe(false);
    expect(Object.hasOwn(failed, 'facts')).toBe(false);
  });
});

// ── Ordinary Text live-fact behavior ────────────────────────────────────────

function ordinaryInput(
  overrides: Partial<Parameters<typeof adaptOrdinaryTextLiveFacts>[0]> = {},
): Parameters<typeof adaptOrdinaryTextLiveFacts>[0] {
  return {
    envelope: ordinaryCase.envelope,
    route: ordinaryCase.route,
    actionCycle: ORDINARY_CYCLE,
    minimumDelta: ordinaryCase.minimumDelta,
    delta: ordinaryPassingObservation(),
    evidence: evidenceAll(ordinaryCase.profile),
    ...overrides,
  };
}

function assertIdentityAgreement(
  checks: readonly CorrectnessCheckResult[],
  profile: ResolvedCorrectnessProfile,
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

describe('[P7-B2-B1] ordinary Text live facts', () => {
  it('produces a complete PASS check with identity/evidence agreement', () => {
    const outcome = evaluateOrdinaryTextLiveChecks(ordinaryInput());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const [check] = outcome.result.checks;
    expect(check?.status).toBe('PASS');
    expect(check?.actual.authority).toBe('current');
    expect(check?.actual.currentness).toBe('current');
    expect(check?.actual.mismatch).toBe(false);
    expect(check?.evidenceIds).toEqual(
      [...(ordinaryCase.profile.requiredChecks[0]?.requiredEvidence ?? [])].sort(),
    );
    assertIdentityAgreement(outcome.result.checks, ordinaryCase.profile, ORDINARY_CYCLE);
  });

  it('produces FAIL for a trustworthy product mismatch', () => {
    const outcome = evaluateOrdinaryTextLiveChecks(
      ordinaryInput({ delta: ordinaryMismatchObservation() }),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.checks[0]?.status).toBe('FAIL');
    expect(outcome.result.checks[0]?.actual.mismatch).toBe(true);
    expect(outcome.result.checks[0]?.actual.authority).toBe('current');
    assertIdentityAgreement(outcome.result.checks, ordinaryCase.profile, ORDINARY_CYCLE);
  });

  it('produces UNUSABLE for missing, stale, torn, and ambiguous authority', () => {
    const cases: readonly [
      string,
      Parameters<typeof adaptOrdinaryTextLiveFacts>[0],
      string,
      string | null,
    ][] = [
      ['missing-fact', ordinaryInput({ delta: null }), 'missing', null],
      [
        'stale',
        ordinaryInput({
          evidence: evidenceAll(ordinaryCase.profile, { 'geometry.canonical': 'stale' }),
        }),
        'stale',
        'geometry.canonical',
      ],
      [
        'torn',
        ordinaryInput({
          delta: ordinaryUnusableObservation(),
          evidence: evidenceAll(ordinaryCase.profile, { 'geometry.renderer': 'torn' }),
        }),
        'torn',
        'geometry.renderer',
      ],
      [
        'ambiguous',
        ordinaryInput({
          evidence: evidenceAll(ordinaryCase.profile, { 'geometry.renderer': 'ambiguous' }),
        }),
        'ambiguous',
        'geometry.renderer',
      ],
    ];
    for (const [label, input, expectedAuthority, unconsumedEvidenceId] of cases) {
      const outcome = evaluateOrdinaryTextLiveChecks(input);
      expect(outcome.ok, label).toBe(true);
      if (!outcome.ok) continue;
      expect(outcome.result.checks[0]?.status, label).toBe('UNUSABLE');
      expect(outcome.result.checks[0]?.actual.authority, label).toBe(expectedAuthority);
      expect(outcome.result.checks[0]?.actual.mismatch, label).toBe(false);
      if (unconsumedEvidenceId !== null) {
        expect(outcome.result.checks[0]?.evidenceIds, label).not.toContain(unconsumedEvidenceId);
      }
    }
  });

  it('passes the observed evidence roles through untouched, never inventing a role', () => {
    const observed = evidenceAll(ordinaryCase.profile);
    const outcome = evaluateOrdinaryTextLiveChecks(
      ordinaryInput({ delta: null, evidence: observed }),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.facts.evidence).toEqual(observed);
    expect(outcome.result.checks[0]?.evidenceIds).toEqual(
      [...(ordinaryCase.profile.requiredChecks[0]?.requiredEvidence ?? [])].sort(),
    );
  });
});

// ── Warped Text live-fact behavior ──────────────────────────────────────────

function warpedInput(
  overrides: Partial<Parameters<typeof adaptWarpedTextLiveFacts>[0]> = {},
): Parameters<typeof adaptWarpedTextLiveFacts>[0] {
  return {
    envelope: warpedCase.envelope,
    route: warpedCase.route,
    actionCycle: WARPED_CYCLE,
    minimumDelta: warpedCase.minimumDelta,
    oracle: warpedPassing(),
    evidence: evidenceAll(warpedCase.profile),
    ...overrides,
  };
}

describe('[P7-B2-B1] circle-warped Text live facts', () => {
  it('produces complete PASS checks from a real warped Oracle evaluation', () => {
    const outcome = evaluateWarpedTextLiveChecks(warpedInput());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.checks.map((check) => check.status)).toEqual(['PASS', 'PASS']);
    for (const check of outcome.result.checks) {
      expect(check.actual.authority).toBe('current');
      expect(check.actual.currentness).toBe('current');
      expect(check.actual.mismatch).toBe(false);
      expect(check.actual.sourcesAgree).toBe(true);
    }
    assertIdentityAgreement(outcome.result.checks, warpedCase.profile, WARPED_CYCLE);
  });

  it('produces a per-check FAIL for a real trustworthy renderer mismatch', () => {
    const oracle = warpedMismatch();
    expect(oracle.harnessInvalid).toBe(false);
    expect(oracle.requiredSourcesAgree).toBe(false);
    const outcome = evaluateWarpedTextLiveChecks(warpedInput({ oracle }));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const delta = outcome.result.checks.find((check) => check.checkId === 'geometry.delta');
    expect(delta?.status).toBe('FAIL');
    expect(delta?.actual.mismatch).toBe(true);
    expect(delta?.actual.sourcesAgree).toBe(false);
    expect(delta?.actual.authority).toBe('current');
    assertIdentityAgreement(outcome.result.checks, warpedCase.profile, WARPED_CYCLE);
  });

  it('maps real malformed authority to UNUSABLE and never to FAIL', () => {
    const oracle = warpedHarnessInvalid();
    expect(oracle.harnessInvalid).toBe(true);
    const outcome = evaluateWarpedTextLiveChecks(warpedInput({ oracle }));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.checks.map((check) => check.status)).toEqual(['UNUSABLE', 'UNUSABLE']);
    for (const check of outcome.result.checks) {
      expect(check.actual.authority).toBe('malformed');
      expect(check.actual.mismatch).toBe(false);
    }
  });

  it('produces UNUSABLE for missing, stale, torn, and ambiguous authority', () => {
    const cases: readonly [string, Parameters<typeof adaptWarpedTextLiveFacts>[0], string][] = [
      ['missing-oracle', warpedInput({ oracle: null }), 'missing'],
      [
        'stale',
        warpedInput({
          evidence: evidenceAll(warpedCase.profile, { 'geometry.typed-envelope': 'stale' }),
        }),
        'stale',
      ],
      [
        'torn',
        warpedInput({
          evidence: evidenceAll(warpedCase.profile, { 'geometry.renderer': 'torn' }),
        }),
        'torn',
      ],
      [
        'ambiguous',
        warpedInput({
          evidence: evidenceAll(warpedCase.profile, { 'geometry.canonical': 'ambiguous' }),
        }),
        'ambiguous',
      ],
    ];
    for (const [label, input, expectedAuthority] of cases) {
      const outcome = evaluateWarpedTextLiveChecks(input);
      expect(outcome.ok, label).toBe(true);
      if (!outcome.ok) continue;
      expect(
        outcome.result.checks.map((check) => check.status),
        label,
      ).toEqual(['UNUSABLE', 'UNUSABLE']);
      for (const check of outcome.result.checks) {
        expect(check.actual.authority, label).toBe(expectedAuthority);
      }
    }
  });

  it('carries no legacy harnessInvalid or boolean passed authority into the kernel facts', () => {
    const adaptation = adaptWarpedTextLiveFacts(warpedInput());
    expect(adaptation.ok).toBe(true);
    if (!adaptation.ok) return;
    const facts = adaptation.facts as WarpedTextKernelFacts;
    expect(Object.hasOwn(facts, 'harnessInvalid')).toBe(false);
    for (const check of facts.checks) {
      expect(Object.hasOwn(check, 'passed')).toBe(false);
      expect(typeof check.authority).toBe('string');
      expect(typeof check.currentness).toBe('string');
      expect(typeof check.sourcesAgree).toBe('boolean');
      expect(typeof check.mismatch).toBe('boolean');
    }
  });

  it('derives its final facts only from additive primitive observations, never from legacy booleans', () => {
    const baseline = evaluateWarpedTextLiveChecks(warpedInput());
    expect(baseline.ok).toBe(true);
    if (!baseline.ok) return;
    expect(baseline.result.checks.map((check) => check.status)).toEqual(['PASS', 'PASS']);

    // Runtime spy: flip every legacy composite check-result boolean and the
    // aggregate harness-validity/source-agreement fields while leaving the
    // additive primitive facts byte-identical. The adapter must not observe any
    // difference: it no longer reads any of those fields.
    const oracle = warpedPassing();
    const flipped = {
      ...oracle,
      checks: oracle.checks.map((check) => ({ ...check, passed: !check.passed })),
      requiredSourcesAgree: !oracle.requiredSourcesAgree,
      harnessInvalid: !oracle.harnessInvalid,
    };
    const afterFlip = evaluateWarpedTextLiveChecks(warpedInput({ oracle: flipped }));
    expect(afterFlip.ok).toBe(true);
    if (!afterFlip.ok) return;
    expect(afterFlip.result.checks.map((check) => check.status)).toEqual(['PASS', 'PASS']);
    expect(afterFlip.facts).toEqual(baseline.facts);
    expect(afterFlip.result.checks).toEqual(baseline.result.checks);

    // A genuine per-check primitive change must change the adapter output.
    const tamperedPrimitives = {
      ...oracle,
      primitiveFacts: {
        ...oracle.primitiveFacts,
        canonicalSourcesAgree: false,
        checks: oracle.primitiveFacts.checks.map((check) => ({
          ...check,
          predicateMet: false,
        })),
      },
    };
    const afterPrimitive = evaluateWarpedTextLiveChecks(
      warpedInput({ oracle: tamperedPrimitives }),
    );
    expect(afterPrimitive.ok).toBe(true);
    if (!afterPrimitive.ok) return;
    expect(afterPrimitive.result.checks.map((check) => check.status)).toEqual(['FAIL', 'FAIL']);
    for (const check of afterPrimitive.result.checks) {
      expect(check.actual.sourcesAgree).toBe(false);
      expect(check.actual.authority).toBe('current');
    }
  });

  it('derives malformed authority from the primitive authority, not the aggregate harness flag', () => {
    const malformed = warpedHarnessInvalid();
    expect(malformed.primitiveFacts.authority).toBe('malformed');
    // Flip the legacy aggregate flag and every legacy boolean to their clean
    // values; the primitive authority remains malformed, so the outcome stays
    // UNUSABLE rather than becoming a fabricated PASS/FAIL.
    const flipped = {
      ...malformed,
      harnessInvalid: false,
      requiredSourcesAgree: true,
      checks: malformed.checks.map((check) => ({ ...check, passed: true })),
    };
    const outcome = evaluateWarpedTextLiveChecks(warpedInput({ oracle: flipped }));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.checks.map((check) => check.status)).toEqual(['UNUSABLE', 'UNUSABLE']);
    for (const check of outcome.result.checks) {
      expect(check.actual.authority).toBe('malformed');
      expect(check.actual.mismatch).toBe(false);
    }
  });
});

// ── No adapter policy, no active imports, no legacy authority ───────────────

describe('[P7-B2-B1] inactive adapter invariants', () => {
  const source = (relative: string): string => readFileSync(path.join(skillRoot, relative), 'utf8');
  const adapterSource = source('src/adapters/text-live-facts.ts');
  const kernelSource = source('src/kernels/text-kernel.ts');

  it('does not import any active executor, Oracle, evidence writer, CLI, browser, or classifier', () => {
    expect(adapterSource).not.toMatch(
      /from '\.\.\/(runtime|oracles|evidence|cli|browser|workflows|commands)\//,
    );
    for (const token of [
      'execute-plan',
      'action-cycle',
      'evaluateRequiredChecks',
      'evaluateWarpedTextOracle',
      'evaluateGeometryDeltaOracle',
      'writeRunRecord',
      'outcomes',
      'contracts/execution',
    ]) {
      expect(adapterSource, token).not.toContain(token);
    }
  });

  it('owns no required-check array, fallback id, deadline, tolerance, visual, or normalization literal', () => {
    for (const token of [
      "'geometry.delta'",
      "'geometry.warp-envelope'",
      "'layer/text'",
      "'canonical-matrix-epsilon-v1'",
      "'renderer-transform-px-v1'",
      "'action-cycle-v1'",
      "'warped-text-action-cycle-v1'",
      "'warped-text-circle-move-v1'",
      'deadlineMs',
      'stableFrames',
      'quiescenceRequired',
      '0.25',
      '1e-6',
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
    expect(adapterSource).not.toContain('evidenceId:');
    expect(adapterSource).not.toMatch(/'PASS'|'FAIL'/);
    // The reconciled kernel input contract no longer exposes legacy authority.
    expect(kernelSource).not.toMatch(/readonly passed: boolean/);
    expect(kernelSource).not.toMatch(/readonly harnessInvalid: boolean/);
  });

  it('reads no legacy composite boolean or aggregate authority field from the warped observation', () => {
    // Scan only executed source, not explanatory comments.
    const code = adapterSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    expect(code).not.toMatch(/\bpassed\b/);
    expect(code).not.toMatch(/\bharnessInvalid\b/);
    expect(code).not.toMatch(/\brequiredSourcesAgree\b/);
    expect(code).not.toMatch(/\.status\b/);
    // The only warped read surface is the additive primitive view plus the raw
    // source evidence the kernel records.
    expect(code).toContain('primitiveFacts');
    expect(code).not.toMatch(/observation\.checks/);
  });

  it('is inactive: not exported from the public barrel and unreferenced by active modules', () => {
    const indexSource = source('src/index.ts');
    expect(indexSource).not.toContain('text-live-facts');
    expect(indexSource).not.toContain('adaptOrdinaryTextLiveFacts');
    expect(indexSource).not.toContain('evaluateWarpedTextLiveChecks');
  });

  it('fails closed with a structured diagnostic on every reported issue', () => {
    const failure = adaptOrdinaryTextLiveFacts(
      ordinaryInput({ evidence: [{ evidenceId: 'x', availability: 'nope' } as never] }),
    );
    expect(failure.ok).toBe(false);
    if (failure.ok) return;
    expect(failure.status).toBe('HARNESS_BLOCKED');
    expect(failure.launchAttempted).toBe(false);
    expect(failure.diagnostic.code).toBe('UNUSABLE_EVIDENCE');
    expect(failure.diagnostic.detail).toContain('TEXT_LIVE_EVIDENCE_FACT_INVALID');
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

describe('[P7-B2-B1] compiled compatibility mutation matrix', () => {
  it('covers at least the accepted 68-field semantic projection', () => {
    const paths = new Set<string>();
    for (const prepared of [ordinaryCase, warpedCase]) {
      const collected: string[] = [];
      collectLeafPaths(prepared.profile, '', collected);
      for (const leaf of collected) paths.add(`${prepared.route.variant}::${leaf}`);
    }
    expect(paths.size).toBeGreaterThanOrEqual(68);
  });

  it('detects every single-leaf mutation of either compiled Text profile', () => {
    for (const prepared of [ordinaryCase, warpedCase]) {
      const collected: string[] = [];
      collectLeafPaths(prepared.profile, '', collected);
      for (const leafPath of collected) {
        const envelope = mutatedEnvelope(prepared.envelope, leafPath);
        const adaptation =
          prepared.route.variant === 'warp-circle'
            ? adaptWarpedTextLiveFacts({
                envelope,
                route: prepared.route,
                actionCycle: WARPED_CYCLE,
                minimumDelta: prepared.minimumDelta,
                oracle: warpedPassing(),
                evidence: evidenceAll(prepared.profile),
              })
            : adaptOrdinaryTextLiveFacts({
                envelope,
                route: prepared.route,
                actionCycle: ORDINARY_CYCLE,
                minimumDelta: prepared.minimumDelta,
                delta: ordinaryPassingObservation(),
                evidence: evidenceAll(prepared.profile),
              });
        expect(
          adaptation.ok,
          `mutation of ${String(prepared.route.variant)}::${leafPath} was not detected`,
        ).toBe(false);
      }
    }
  });

  it('detects a mutated component fingerprint that is retained against the stored resolved identity', () => {
    const swapped = cloneProfile(ordinaryCase.profile);
    const clone = swapped as unknown as Record<string, unknown>;
    (clone.componentFingerprints as Record<string, unknown>).oracle = 'c'.repeat(64);
    const envelope = {
      ...ordinaryCase.envelope,
      correctnessProfile: clone,
    } as unknown as MaterializedExecutionEnvelopeV1;
    const adaptation = adaptOrdinaryTextLiveFacts({
      envelope,
      route: ordinaryCase.route,
      actionCycle: ORDINARY_CYCLE,
      minimumDelta: ordinaryCase.minimumDelta,
      delta: ordinaryPassingObservation(),
      evidence: evidenceAll(ordinaryCase.profile),
    });
    expect(adaptation.ok).toBe(false);
  });

  it('keeps an unrelated valid envelope accepted after the mutation matrix', () => {
    const adaptation = adaptOrdinaryTextLiveFacts({
      envelope: ordinaryCase.envelope,
      route: ordinaryCase.route,
      actionCycle: ORDINARY_CYCLE,
      minimumDelta: ordinaryCase.minimumDelta,
      delta: ordinaryPassingObservation(),
      evidence: evidenceAll(ordinaryCase.profile),
    });
    expect(adaptation.ok).toBe(true);
    if (adaptation.ok) {
      const facts = adaptation.facts as OrdinaryTextKernelFacts;
      expect(facts.check?.checkId).toBe('geometry.delta');
    }
  });
});
