import { describe, expect, it } from 'vitest';

import {
  affineAgreesWithin,
  applyAffine,
  canonicalCircleControlEnvelopeLayoutQuad,
  circleControlBounds,
  computeCircleWarpFingerprint,
  computeRepresentationFingerprint,
  multiplyAffine,
  scaleAffine,
  translationAffine,
  type Affine2D,
  type CircleWarpPayloadInput,
  type Quad,
  type TypedGeometryResult,
} from '../../src/contracts/geometry-v2';
import {
  evaluateWarpedTextOracle,
  findWarpedCanonicalLayer,
  type WarpedTextOracleInput,
} from '../../src/oracles/warped-text';

/**
 * `warped-text-circle-move-v1` Oracle (WP5 Slice 5-B; R13, P4/P5).
 *
 * The renderer records here are built independently of the canonical
 * expectation but composed through the same five-matrix chain a correct bridge
 * publishes, so the Oracle can be driven through PASS, delta failure, envelope
 * failure, parent change, and malformed-authority cases.
 */

const PADDING = 14;
const LAYOUT_ID = 'layout-a';
const TARGET_ID = 'layout-a-text-1';

const PAYLOAD: CircleWarpPayloadInput = {
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

function snapshot(layers: unknown[]): unknown {
  return [
    {
      id: LAYOUT_ID,
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

function canonicalLayer(position: { x: number; y: number }, payload = PAYLOAD, flipX = false) {
  return {
    id: TARGET_ID,
    type: 'TEXT',
    xCoordinate: position.x,
    yCoordinate: position.y,
    rotation: 0,
    transform: { flipX, flipY: false },
    warp: { type: 'circle', payload },
  };
}

interface RendererViewOptions {
  position: { x: number; y: number };
  payload?: CircleWarpPayloadInput;
  flipX?: boolean;
  /** Renderer-only deviation added to one browser-client point (CSS px). */
  pointDeviationCss?: number;
  layoutTranslation?: { x: number; y: number };
  cssRatio?: number;
  generation?: number;
}

function rawQuad(payload: CircleWarpPayloadInput): Quad {
  const bounds = circleControlBounds(payload);
  if (bounds === null) throw new Error('bounds unavailable');
  return [
    { x: bounds.left, y: bounds.top },
    { x: bounds.right, y: bounds.top },
    { x: bounds.right, y: bounds.bottom },
    { x: bounds.left, y: bounds.bottom },
  ];
}

function transform(quad: Quad, matrix: Affine2D): Quad {
  return [
    applyAffine(matrix, quad[0]),
    applyAffine(matrix, quad[1]),
    applyAffine(matrix, quad[2]),
    applyAffine(matrix, quad[3]),
  ];
}

/** A consistent typed geometry record for one canonical layer position. */
function rendererView(options: RendererViewOptions): TypedGeometryResult {
  const payload = options.payload ?? PAYLOAD;
  const position = options.position;
  const flips = { x: options.flipX === true, y: false };
  const bounds = circleControlBounds(payload);
  if (bounds === null) throw new Error('bounds unavailable');
  const warpControlLocal = rawQuad(payload);
  const frameWidth = bounds.width + PADDING * 2;
  const frameHeight = bounds.height + PADDING * 2;
  const translateIntoFrame = translationAffine(PADDING - bounds.x, PADDING - bounds.y);
  const flip: Affine2D = {
    a: flips.x ? -1 : 1,
    b: 0,
    c: 0,
    d: 1,
    e: flips.x ? frameWidth : 0,
    f: 0,
  };
  const warpControlToSubjectFrame = multiplyAffine(flip, translateIntoFrame);
  const subjectFrameLocal = transform(warpControlLocal, warpControlToSubjectFrame);
  const subjectFrameToLayout = translationAffine(position.x - PADDING, position.y - PADDING);
  const layoutLocal = transform(subjectFrameLocal, subjectFrameToLayout);
  const layoutTranslation = options.layoutTranslation ?? { x: 120, y: 90 };
  const layoutToWorldScene = translationAffine(layoutTranslation.x, layoutTranslation.y);
  const cssRatio = options.cssRatio ?? 1;
  const worldSceneToStageViewportCss = scaleAffine(1 / cssRatio, 1 / cssRatio);
  const stageViewportToBrowserClientCss = translationAffine(20, 10);
  const worldScene = transform(layoutLocal, layoutToWorldScene);
  const stageViewportCss = transform(worldScene, worldSceneToStageViewportCss);
  let browserClientCss = transform(stageViewportCss, stageViewportToBrowserClientCss);
  if (options.pointDeviationCss) {
    // `Quad` is a readonly tuple: build a new tuple instead of mutating it.
    browserClientCss = [
      browserClientCss[0],
      browserClientCss[1],
      {
        x: browserClientCss[2].x + options.pointDeviationCss,
        y: browserClientCss[2].y,
      },
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
  const generation = options.generation ?? 1;
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
      padding: { left: PADDING, right: PADDING, top: PADDING, bottom: PADDING },
      controlBounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
      subjectFrame: {
        width: frameWidth,
        height: frameHeight,
        flipCenterX: frameWidth / 2,
        flipCenterY: frameHeight / 2,
      },
      flips,
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
    targetId: TARGET_ID,
    layoutId: LAYOUT_ID,
    cssRatios: { x: cssRatio, y: cssRatio },
    bridgeGeneration: generation,
    warpFingerprint,
  });
  return {
    schemaVersion: 2,
    typedProvenance: {
      schemaVersion: 2,
      bridgeGeneration: generation,
      stageFingerprint: 'stage',
      target: {
        id: TARGET_ID,
        konvaId: TARGET_ID,
        nodeClass: 'Group',
        subjectFrameToLayout,
        fingerprint: 'target',
      },
      layout: {
        id: LAYOUT_ID,
        konvaId: `layout-${LAYOUT_ID}`,
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
    cssRatios: { x: cssRatio, y: cssRatio },
  };
}

function input(
  beforePosition = { x: 125, y: 125 },
  afterPosition = { x: 205, y: 165 },
  overrides: {
    before?: Partial<RendererViewOptions>;
    after?: Partial<RendererViewOptions>;
    flipX?: boolean;
    payload?: CircleWarpPayloadInput;
    afterPayload?: CircleWarpPayloadInput;
  } = {},
): WarpedTextOracleInput {
  const payload = overrides.payload ?? PAYLOAD;
  const afterPayload = overrides.afterPayload ?? payload;
  const flipX = overrides.flipX ?? false;
  return {
    minimumDelta: { x: 40, y: 20 },
    targetId: TARGET_ID,
    expectedLayoutId: LAYOUT_ID,
    baseline: {
      layoutItems: snapshot([canonicalLayer(beforePosition, payload, flipX)]),
      geometryV2: rendererView({
        position: beforePosition,
        payload,
        flipX,
        ...overrides.before,
      }),
    },
    observed: {
      layoutItems: snapshot([canonicalLayer(afterPosition, afterPayload, flipX)]),
      geometryV2: rendererView({
        position: afterPosition,
        payload: afterPayload,
        flipX,
        ...overrides.after,
      }),
    },
  };
}

describe('warped-text-circle-move-v1 Oracle (R13)', () => {
  it('passes when a real move satisfies both required checks', () => {
    const result = evaluateWarpedTextOracle(input());
    expect(result.harnessInvalid).toBe(false);
    expect(result.checks).toEqual([
      { checkId: 'geometry.delta', passed: true },
      { checkId: 'geometry.warp-envelope', passed: true },
    ]);
    expect(result.requiredSourcesAgree).toBe(true);
    expect(result.delta.canonicalDelta).toEqual({ x: 80, y: 40 });
    expect(result.delta.maxPointAxisDeviation).toBe(0);
  });

  it('passes under a translated Layout, non-identity CSS ratio, and flips', () => {
    const result = evaluateWarpedTextOracle(
      input(
        { x: 125, y: 125 },
        { x: 205, y: 165 },
        {
          flipX: true,
          before: { cssRatio: 2, layoutTranslation: { x: 300, y: 150 } },
          after: { cssRatio: 2, layoutTranslation: { x: 300, y: 150 } },
        },
      ),
    );
    expect(result.harnessInvalid).toBe(false);
    expect(result.checks.every((check) => check.passed)).toBe(true);
  });

  it('fails geometry.delta when one corresponding point moves outside tolerance', () => {
    const result = evaluateWarpedTextOracle(
      input(undefined, undefined, { after: { pointDeviationCss: 0.6 } }),
    );
    expect(result.harnessInvalid).toBe(false);
    expect(result.checks).toEqual([
      { checkId: 'geometry.delta', passed: false },
      { checkId: 'geometry.warp-envelope', passed: false },
    ]);
    expect(result.delta.maxPointAxisDeviation).toBeGreaterThan(0.25);
    expect(result.requiredSourcesAgree).toBe(false);
  });

  it('passes exactly at the 0.25 CSS px tolerance and fails immediately outside (R13; test 48)', () => {
    const atBoundary = evaluateWarpedTextOracle(
      input(undefined, undefined, { after: { pointDeviationCss: 0.25 } }),
    );
    expect(atBoundary.harnessInvalid).toBe(false);
    expect(atBoundary.checks.every((check) => check.passed)).toBe(true);
    expect(atBoundary.delta.maxPointAxisDeviation).toBeCloseTo(0.25, 12);
    expect(atBoundary.envelope.maxRenderedDeviation).toBeCloseTo(0.25, 12);

    const outside = evaluateWarpedTextOracle(
      input(undefined, undefined, { after: { pointDeviationCss: 0.25 + 1e-6 } }),
    );
    expect(outside.checks).toEqual([
      { checkId: 'geometry.delta', passed: false },
      { checkId: 'geometry.warp-envelope', passed: false },
    ]);
    expect(outside.delta.maxPointAxisDeviation).toBeGreaterThan(0.25);
  });

  it('fails geometry.delta when the canonical movement is below the required minimum', () => {
    const result = evaluateWarpedTextOracle(input({ x: 125, y: 125 }, { x: 145, y: 135 }));
    const delta = result.checks.find((check) => check.checkId === 'geometry.delta');
    expect(delta?.passed).toBe(false);
  });

  it('fails geometry.warp-envelope when the warp payload changes', () => {
    const changed: CircleWarpPayloadInput = { ...PAYLOAD, arcAlign: 'start' };
    const result = evaluateWarpedTextOracle(input(undefined, undefined, { afterPayload: changed }));
    const envelope = result.checks.find((check) => check.checkId === 'geometry.warp-envelope');
    expect(envelope?.passed).toBe(false);
    expect(result.diagnostics.map((entry) => entry.detail).join(' ')).toContain(
      'warp-fingerprint-changed',
    );
  });

  it('cannot pass when the parent Layout changes', () => {
    const moved = input();
    (moved.observed.layoutItems as { id: string }[])[0].id = 'layout-b';
    const result = evaluateWarpedTextOracle(moved);
    expect(result.harnessInvalid).toBe(true);
    expect(result.checks.every((check) => !check.passed)).toBe(true);
    expect(result.diagnostics.map((entry) => entry.code)).toContain('GEOMETRY_LAYOUT_ID_MISMATCH');
  });

  it('blocks malformed authority instead of reporting a product defect', () => {
    const missing = input();
    missing.observed.geometryV2 = null;
    const result = evaluateWarpedTextOracle(missing);
    expect(result.harnessInvalid).toBe(true);
    expect(result.diagnostics.map((entry) => entry.code)).toContain('GEOMETRY_TRANSFORM_INVALID');

    const tampered = input();
    tampered.observed.geometryV2!.representation.representationFingerprint = 'deadbeefdeadbeef';
    const tamperedResult = evaluateWarpedTextOracle(tampered);
    expect(tamperedResult.harnessInvalid).toBe(true);
  });

  it('resolves the canonical circle layer with its parent Layout and warp payload', () => {
    const layer = findWarpedCanonicalLayer(
      snapshot([canonicalLayer({ x: 125, y: 125 })]),
      TARGET_ID,
    );
    expect(layer).not.toBeNull();
    expect(layer?.parentLayoutId).toBe(LAYOUT_ID);
    expect(layer?.payload.centerX).toBe(99);
    expect(layer?.flipX).toBe(false);
    expect(
      affineAgreesWithin(
        {
          a: 1,
          b: 0,
          c: 0,
          d: 1,
          e: 0,
          f: 0,
        },
        { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
      ),
    ).toBe(true);
  });

  it('keeps the canonical padding-free transform independent of the renderer record', () => {
    const canonical = canonicalCircleControlEnvelopeLayoutQuad({
      payload: PAYLOAD,
      xCoordinate: 125,
      yCoordinate: 125,
      rotationDegrees: 0,
      flipX: false,
      flipY: false,
    });
    expect(canonical).toEqual([
      { x: 125, y: 125 },
      { x: 323, y: 125 },
      { x: 323, y: 323 },
      { x: 125, y: 323 },
    ]);
  });
});

describe('warped-text-circle-move-v1 additive primitive facts (ADR 0029 §4 B2-B)', () => {
  it('derives current check predicates and source agreement from raw observations', () => {
    const passing = evaluateWarpedTextOracle(input());
    expect(passing.checks).toEqual([
      { checkId: 'geometry.delta', passed: true },
      { checkId: 'geometry.warp-envelope', passed: true },
    ]);
    expect(passing.primitiveFacts.authority).toBe('current');
    expect(passing.primitiveFacts.checks).toEqual([
      { checkId: 'geometry.delta', predicateMet: true },
      { checkId: 'geometry.warp-envelope', predicateMet: true },
    ]);
    expect(passing.primitiveFacts.canonicalSourcesAgree).toBe(true);
    expect(passing.primitiveFacts.rendererSourcesAgree).toBe(true);
    expect(passing.primitiveFacts.measured.canonicalDelta).toEqual({ x: 80, y: 40 });
    expect(passing.primitiveFacts.measured.minimumDelta).toEqual({ x: 40, y: 20 });
    expect(passing.primitiveFacts.tolerances).toEqual({
      canonical: expect.any(Number),
      renderer: expect.any(Number),
    });

    const failing = evaluateWarpedTextOracle(
      input(undefined, undefined, { after: { pointDeviationCss: 0.6 } }),
    );
    expect(failing.checks).toEqual([
      { checkId: 'geometry.delta', passed: false },
      { checkId: 'geometry.warp-envelope', passed: false },
    ]);
    expect(failing.primitiveFacts.checks).toEqual([
      { checkId: 'geometry.delta', predicateMet: false },
      { checkId: 'geometry.warp-envelope', predicateMet: false },
    ]);
    expect(failing.primitiveFacts.rendererSourcesAgree).toBe(false);
  });

  it('exposes the primitive predicate exactly where the legacy boolean result sits', () => {
    for (const result of [
      evaluateWarpedTextOracle(input()),
      evaluateWarpedTextOracle(input(undefined, undefined, { after: { pointDeviationCss: 0.6 } })),
      evaluateWarpedTextOracle(input({ x: 125, y: 125 }, { x: 145, y: 135 })),
      evaluateWarpedTextOracle(
        input(undefined, undefined, { afterPayload: { ...PAYLOAD, arcAlign: 'start' } }),
      ),
    ]) {
      expect(result.primitiveFacts.authority).toBe('current');
      expect(result.primitiveFacts.checks).toEqual(
        result.checks.map((check) => ({ checkId: check.checkId, predicateMet: check.passed })),
      );
      expect(
        result.primitiveFacts.canonicalSourcesAgree && result.primitiveFacts.rendererSourcesAgree,
      ).toBe(result.requiredSourcesAgree);
    }
  });

  it('states a malformed primitive authority without any readable measurement', () => {
    const malformed = input();
    malformed.observed.geometryV2 = null;
    const result = evaluateWarpedTextOracle(malformed);
    expect(result.harnessInvalid).toBe(true);
    expect(result.primitiveFacts.authority).toBe('malformed');
    expect(result.primitiveFacts.canonicalSourcesAgree).toBe(false);
    expect(result.primitiveFacts.rendererSourcesAgree).toBe(false);
    expect(result.primitiveFacts.measured).toEqual({
      canonicalDelta: null,
      minimumDelta: null,
      maxPointAxisDeviation: null,
      maxCanonicalDeviation: null,
      maxRenderedDeviation: null,
      envelopeFailures: [],
    });
    expect(result.primitiveFacts.checks).toEqual([
      { checkId: 'geometry.delta', predicateMet: false },
      { checkId: 'geometry.warp-envelope', predicateMet: false },
    ]);
  });

  it('carries no legacy composite boolean result field in the additive primitive view', () => {
    const result = evaluateWarpedTextOracle(input());
    expect(Object.hasOwn(result.primitiveFacts, 'passed')).toBe(false);
    expect(Object.hasOwn(result.primitiveFacts, 'status')).toBe(false);
    expect(Object.hasOwn(result.primitiveFacts, 'harnessInvalid')).toBe(false);
    for (const check of result.primitiveFacts.checks) {
      expect(Object.hasOwn(check, 'passed')).toBe(false);
      expect(Object.hasOwn(check, 'status')).toBe(false);
    }
  });
});
