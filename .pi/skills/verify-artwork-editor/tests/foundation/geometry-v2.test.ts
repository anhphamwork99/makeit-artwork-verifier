import { describe, expect, it } from 'vitest';

import { createDefaultArtworkTextLayer } from '@/stores/artwork/textLayerSlice';
import { createDefaultCircleWarpPayload } from '@/stores/artwork/textLayerSlice';
import { useArtworkTextFrameGeometry } from '@/hooks/artwork/editor/warpText/useArtworkTextFrameGeometry';
import {
  CIRCLE_CONTROL_ENVELOPE_KIND,
  CIRCLE_CONTROL_ENVELOPE_POINT_ORDER,
  CIRCLE_TEXT_FRAME_PROJECTION_KIND,
  GEOMETRY_MATRIX_KEYS,
  GEOMETRY_MATRIX_RECONSTRUCTION_TOLERANCE,
  GEOMETRY_SCHEMA_VERSION,
  GEOMETRY_SPACE_UNITS,
  HIT_POINT_INSET_CSS_PX,
  IDENTITY_AFFINE,
  affineAgreesWithin,
  applyAffine,
  bilinearPoint,
  canonicalCircleControlToLayoutMatrix,
  canonicalWarpControlQuad,
  circleControlBounds,
  composeChain,
  computeCircleWarpFingerprint,
  computeRepresentationFingerprint,
  determinantParity,
  distanceToQuadEdges,
  eligibleHitPointCandidates,
  invertAffine,
  linearPart,
  multiplyAffine,
  pointInConvexQuad,
  quadArea,
  quadCentroid,
  quadIsConvex,
  quadIsSimple,
  quadSelfIntersects,
  quadWindingSign,
  reconstructWarpControlToSubjectFrame,
  rotationAffine,
  scaleAffine,
  subjectFrameToLayoutMatrix,
  transformQuad,
  translationAffine,
  validateCircleTextFrameProjection,
  validateTypedGeometry,
  type Affine2D,
  type CircleControlBounds,
  type CircleControlEnvelopeQuadV1,
  type CircleTextFrameProjectionV1,
  type CircleWarpPayloadInput,
  type Quad,
} from '../../src/contracts/geometry-v2';

function payload(overrides: Partial<CircleWarpPayloadInput> = {}): CircleWarpPayloadInput {
  return {
    centerX: 60,
    centerY: 40,
    radius: 60,
    radiusY: 40,
    rotationAngle: -Math.PI / 2,
    arcLength: 0,
    inverted: false,
    verticalAlign: 'center',
    arcAlign: 'end',
    ...overrides,
  };
}

function approxPoint(actual: { x: number; y: number }, expected: { x: number; y: number }): void {
  expect(actual.x).toBeCloseTo(expected.x, 9);
  expect(actual.y).toBeCloseTo(expected.y, 9);
}

function boundsOf(p: CircleWarpPayloadInput): CircleControlBounds {
  const bounds = circleControlBounds(p);
  if (bounds === null) throw new Error('test payload produced no control bounds');
  return bounds;
}

interface Flips {
  flipX: boolean;
  flipY: boolean;
}

const NO_FLIPS: Flips = { flipX: false, flipY: false };

/**
 * Builds a complete, internally consistent `circle-text-frame-projection-v1`
 * record from synthetic facts. Padding is deliberately arbitrary so the toolkit
 * never assumes a product padding value.
 */
function symmetricProjection(
  p: CircleWarpPayloadInput,
  paddingPx: number,
  flips: Flips,
): CircleTextFrameProjectionV1 {
  const bounds = boundsOf(p);
  const width = bounds.width + paddingPx * 2;
  const height = bounds.height + paddingPx * 2;
  return {
    kind: CIRCLE_TEXT_FRAME_PROJECTION_KIND,
    padding: { left: paddingPx, right: paddingPx, top: paddingPx, bottom: paddingPx },
    controlBounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
    subjectFrame: { width, height, flipCenterX: width / 2, flipCenterY: height / 2 },
    flips: { x: flips.flipX, y: flips.flipY },
  };
}

interface RendererChainOptions {
  paddingPx: number;
  flips: Flips;
  xCoordinate: number;
  yCoordinate: number;
  rotationDegrees: number;
}

/**
 * Models the full renderer chain from published-style facts: the reconstructed
 * inner padding translation + flip, then the outer frame placement/rotation.
 * This is the reference the padding-free canonical matrix must equal (P1).
 */
function rendererControlToLayout(
  p: CircleWarpPayloadInput,
  options: RendererChainOptions,
): {
  projection: CircleTextFrameProjectionV1;
  warpControlToSubjectFrame: Affine2D;
  matrix: Affine2D;
} {
  const projection = symmetricProjection(p, options.paddingPx, options.flips);
  const warpControlToSubjectFrame = reconstructWarpControlToSubjectFrame(projection);
  if (warpControlToSubjectFrame === null) throw new Error('projection reconstruction failed');
  const subjectFrameToLayout = subjectFrameToLayoutMatrix({
    frameX: options.xCoordinate - projection.padding.left,
    frameY: options.yCoordinate - projection.padding.top,
    frameWidth: projection.subjectFrame.width,
    frameHeight: projection.subjectFrame.height,
    rotationDegrees: options.rotationDegrees,
  });
  return {
    projection,
    warpControlToSubjectFrame,
    matrix: multiplyAffine(subjectFrameToLayout, warpControlToSubjectFrame),
  };
}

function canonicalMatrix(p: CircleWarpPayloadInput, options: RendererChainOptions): Affine2D {
  const matrix = canonicalCircleControlToLayoutMatrix({
    payload: p,
    xCoordinate: options.xCoordinate,
    yCoordinate: options.yCoordinate,
    rotationDegrees: options.rotationDegrees,
    flipX: options.flips.flipX,
    flipY: options.flips.flipY,
  });
  if (matrix === null) throw new Error('canonical matrix was null');
  return matrix;
}

function expectAffinesAgree(left: Affine2D, right: Affine2D, tolerance = 1e-6): void {
  for (const coefficient of ['a', 'b', 'c', 'd', 'e', 'f'] as const) {
    expect(Math.abs(left[coefficient] - right[coefficient])).toBeLessThanOrEqual(tolerance);
  }
}

/** Deterministic 32-bit PRNG so the broad-sample property test is reproducible. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

describe('geometry v2 — representation identity and point order (R1, tests 1–2)', () => {
  it('produces the exact raw control box in the permanent semantic order', () => {
    const quad = canonicalWarpControlQuad(payload());
    expect(quad).not.toBeNull();
    const [tl, tr, br, bl] = quad as Quad;
    approxPoint(tl, { x: 0, y: 0 });
    approxPoint(tr, { x: 120, y: 0 });
    approxPoint(br, { x: 120, y: 80 });
    approxPoint(bl, { x: 0, y: 80 });
    expect(CIRCLE_CONTROL_ENVELOPE_POINT_ORDER).toEqual([
      'top-left',
      'top-right',
      'bottom-right',
      'bottom-left',
    ]);
  });

  it('honours non-default center, radius and radiusY', () => {
    const quad = canonicalWarpControlQuad(
      payload({ centerX: 200, centerY: 150, radius: 30, radiusY: 10 }),
    ) as Quad;
    approxPoint(quad[0], { x: 170, y: 140 });
    approxPoint(quad[1], { x: 230, y: 140 });
    approxPoint(quad[2], { x: 230, y: 160 });
    approxPoint(quad[3], { x: 170, y: 160 });
  });

  it('clamps a zero/negative payload radius exactly as the renderer does', () => {
    const bounds = circleControlBounds(payload({ radius: 0, radiusY: -5 }));
    expect(bounds?.radius).toBe(1);
    expect(bounds?.radiusY).toBe(1);
  });

  it('returns null for a non-finite payload instead of a degenerate envelope', () => {
    expect(circleControlBounds(payload({ centerX: Number.NaN }))).toBeNull();
    expect(canonicalWarpControlQuad(payload({ radiusY: Number.POSITIVE_INFINITY }))).toBeNull();
  });
});

describe('geometry v2 — product circle invariant boundary (P2, P9)', () => {
  it('confirms the product circle frame carries zero frame shift and symmetric padding', () => {
    // Invariant-boundary regression: the symmetric-padding cancellation model is
    // only valid while circle `frameShiftX/Y === 0` and all four frame pads agree.
    // This reads the product frame geometry as a fact — it does not copy, import,
    // or parameterize the product's padding formula.
    const layer = createDefaultArtworkTextLayer({ id: 't', x: 0, y: 0, zCoordinate: 1 });
    layer.warp = { type: 'circle', payload: createDefaultCircleWarpPayload(99) };
    const frame = useArtworkTextFrameGeometry({
      layer,
      isEditing: false,
      measuredSize: { width: 0, height: 0 },
      warpBounds: { x: 0, y: 0 },
    });
    expect(frame.frameShiftX).toBe(0);
    expect(frame.frameShiftY).toBe(0);
    expect(frame.padLeft).toBe(frame.padRight);
    expect(frame.padLeft).toBe(frame.padTop);
    expect(frame.padLeft).toBe(frame.padBottom);
  });
});

describe('geometry v2 — padding-free canonical control-to-Layout matrix (P1, P4)', () => {
  it('places the unrotated top-left control corner at (xCoordinate, yCoordinate)', () => {
    const p = payload();
    const matrix = canonicalMatrix(p, {
      paddingPx: 0,
      flips: NO_FLIPS,
      xCoordinate: 91,
      yCoordinate: 47,
      rotationDegrees: 0,
    });
    approxPoint(applyAffine(matrix, { x: boundsOf(p).left, y: boundsOf(p).top }), {
      x: 91,
      y: 47,
    });
  });

  it('honours non-default center and radii without any padding input', () => {
    const p = payload({ centerX: 12.5, centerY: -8, radius: 3.25, radiusY: 9.75 });
    const matrix = canonicalMatrix(p, {
      paddingPx: 0,
      flips: NO_FLIPS,
      xCoordinate: 0,
      yCoordinate: 0,
      rotationDegrees: 0,
    });
    const raw = canonicalWarpControlQuad(p) as Quad;
    approxPoint(applyAffine(matrix, raw[0]), { x: 0, y: 0 });
    approxPoint(applyAffine(matrix, raw[1]), { x: 6.5, y: 0 });
    approxPoint(applyAffine(matrix, raw[2]), { x: 6.5, y: 19.5 });
  });

  it('applies each flip and combined flips about the control-envelope center', () => {
    const p = payload();
    const raw = canonicalWarpControlQuad(p) as Quad;
    const base = {
      paddingPx: 0,
      xCoordinate: 0,
      yCoordinate: 0,
      rotationDegrees: 0,
    } as const;

    const flipX = canonicalMatrix(p, { ...base, flips: { flipX: true, flipY: false } });
    approxPoint(applyAffine(flipX, raw[0]), { x: 120, y: 0 });
    approxPoint(applyAffine(flipX, raw[1]), { x: 0, y: 0 });

    const flipY = canonicalMatrix(p, { ...base, flips: { flipX: false, flipY: true } });
    approxPoint(applyAffine(flipY, raw[0]), { x: 0, y: 80 });
    approxPoint(applyAffine(flipY, raw[3]), { x: 0, y: 0 });

    const both = canonicalMatrix(p, { ...base, flips: { flipX: true, flipY: true } });
    approxPoint(applyAffine(both, raw[0]), { x: 120, y: 80 });
    approxPoint(applyAffine(both, raw[2]), { x: 0, y: 0 });
  });

  it('is completely independent of the symmetric padding value', () => {
    const p = payload();
    const zero = canonicalMatrix(p, {
      paddingPx: 0,
      flips: { flipX: true, flipY: false },
      xCoordinate: 17,
      yCoordinate: -23,
      rotationDegrees: 33,
    });
    const large = canonicalMatrix(p, {
      paddingPx: 137.5,
      flips: { flipX: true, flipY: false },
      xCoordinate: 17,
      yCoordinate: -23,
      rotationDegrees: 33,
    });
    expectAffinesAgree(zero, large, 0);
  });

  it('returns null for a non-finite position or rotation', () => {
    expect(
      canonicalCircleControlToLayoutMatrix({
        payload: payload(),
        xCoordinate: Number.NaN,
        yCoordinate: 0,
        rotationDegrees: 0,
        flipX: false,
        flipY: false,
      }),
    ).toBeNull();
    expect(
      canonicalCircleControlToLayoutMatrix({
        payload: payload(),
        xCoordinate: 0,
        yCoordinate: 0,
        rotationDegrees: Number.POSITIVE_INFINITY,
        flipX: false,
        flipY: false,
      }),
    ).toBeNull();
  });
});

describe('geometry v2 — symmetric-padding cancellation (P1, P9)', () => {
  it('equals the full renderer chain for non-default centers, radii, flips and rotation', () => {
    const p = payload({ centerX: 143.25, centerY: -61.5, radius: 88.75, radiusY: 21.5 });
    for (const flips of [
      NO_FLIPS,
      { flipX: true, flipY: false },
      { flipX: false, flipY: true },
      { flipX: true, flipY: true },
    ]) {
      const options: RendererChainOptions = {
        paddingPx: 37.5,
        flips,
        xCoordinate: 410.25,
        yCoordinate: -55,
        rotationDegrees: -117.5,
      };
      expectAffinesAgree(canonicalMatrix(p, options), rendererControlToLayout(p, options).matrix);
    }
  });

  it('treats zero padding and a large synthetic padding identically', () => {
    const p = payload({ centerX: -20, centerY: 15, radius: 9.5, radiusY: 4 });
    const raw = canonicalWarpControlQuad(p) as Quad;
    for (const paddingPx of [0, 250]) {
      const options: RendererChainOptions = {
        paddingPx,
        flips: { flipX: true, flipY: true },
        xCoordinate: 5,
        yCoordinate: 6,
        rotationDegrees: 45,
      };
      const rendererQuad = transformQuad(rendererControlToLayout(p, options).matrix, raw);
      const canonicalQuad = transformQuad(canonicalMatrix(p, options), raw);
      for (let index = 0; index < 4; index += 1) {
        approxPoint(rendererQuad[index], canonicalQuad[index]);
      }
    }
  });

  it('treats top alignment (a padding-only change) as envelope-neutral', () => {
    const p = payload({ verticalAlign: 'top' });
    const raw = canonicalWarpControlQuad(p) as Quad;
    const base: RendererChainOptions = {
      paddingPx: 3,
      flips: NO_FLIPS,
      xCoordinate: 200,
      yCoordinate: 140,
      rotationDegrees: 12,
    };
    const grown: RendererChainOptions = { ...base, paddingPx: base.paddingPx + 17 };
    const baseQuad = transformQuad(rendererControlToLayout(p, base).matrix, raw);
    const grownQuad = transformQuad(rendererControlToLayout(p, grown).matrix, raw);
    const canonicalQuad = transformQuad(canonicalMatrix(p, base), raw);
    for (let index = 0; index < 4; index += 1) {
      approxPoint(baseQuad[index], canonicalQuad[index]);
      approxPoint(grownQuad[index], canonicalQuad[index]);
    }
  });

  it('preserves agreement through a common arbitrary downstream Layout affine', () => {
    const p = payload({ centerX: 31, centerY: 77, radius: 44, radiusY: 12 });
    const raw = canonicalWarpControlQuad(p) as Quad;
    const options: RendererChainOptions = {
      paddingPx: 25,
      flips: { flipX: false, flipY: true },
      xCoordinate: -140,
      yCoordinate: 260,
      rotationDegrees: 71,
    };
    const downstream = composeChain({
      warpControlToSubjectFrame: IDENTITY_AFFINE,
      subjectFrameToLayout: multiplyAffine(
        translationAffine(560, -30),
        multiplyAffine(scaleAffine(0.75, 1.25), rotationAffine(0.31)),
      ),
      layoutToWorldScene: translationAffine(12, 34),
      worldSceneToStageViewportCss: multiplyAffine(translationAffine(30, 20), scaleAffine(2, 0.5)),
      stageViewportToBrowserClientCss: translationAffine(7, -3),
    });
    const rendererChain = multiplyAffine(downstream, rendererControlToLayout(p, options).matrix);
    const canonicalChain = multiplyAffine(downstream, canonicalMatrix(p, options));
    expectAffinesAgree(canonicalChain, rendererChain);
    const rendererQuad = transformQuad(rendererChain, raw);
    const canonicalQuad = transformQuad(canonicalChain, raw);
    for (let index = 0; index < 4; index += 1) {
      approxPoint(rendererQuad[index], canonicalQuad[index]);
    }
  });

  it('is a discriminating check: a non-cancelling frame origin no longer matches', () => {
    const p = payload({ centerX: 70, centerY: 25, radius: 44, radiusY: 18 });
    const options: RendererChainOptions = {
      paddingPx: 30,
      flips: { flipX: true, flipY: false },
      xCoordinate: 120,
      yCoordinate: -80,
      rotationDegrees: 37,
    };
    const canonical = canonicalMatrix(p, options);
    const projection = symmetricProjection(p, options.paddingPx, options.flips);
    const wrongWarp = reconstructWarpControlToSubjectFrame(projection) as Affine2D;
    // Deliberately wrong renderer model: the frame origin omits the padding
    // subtraction, so padding no longer cancels.
    const wrong = multiplyAffine(
      subjectFrameToLayoutMatrix({
        frameX: options.xCoordinate,
        frameY: options.yCoordinate,
        frameWidth: projection.subjectFrame.width,
        frameHeight: projection.subjectFrame.height,
        rotationDegrees: options.rotationDegrees,
      }),
      wrongWarp,
    );
    expect(affineAgreesWithin(canonical, wrong)).toBe(false);
  });

  it('holds across a deterministic 10,000-case seeded cross-product sample (P9)', () => {
    const random = mulberry32(0x5b0505);
    for (let iteration = 0; iteration < 10_000; iteration += 1) {
      const p = payload({
        centerX: (random() - 0.5) * 800,
        centerY: (random() - 0.5) * 600,
        radius: 1 + random() * 300,
        radiusY: 1 + random() * 200,
        rotationAngle: (random() - 0.5) * Math.PI * 2,
        arcLength: random() * 2,
        inverted: random() > 0.5,
        verticalAlign: random() > 0.5 ? 'top' : 'center',
        arcAlign: random() > 0.5 ? 'start' : 'end',
      });
      const options: RendererChainOptions = {
        paddingPx: random() * 150,
        flips: { flipX: random() > 0.5, flipY: random() > 0.5 },
        xCoordinate: (random() - 0.5) * 1000,
        yCoordinate: (random() - 0.5) * 1000,
        rotationDegrees: (random() - 0.5) * 720,
      };
      const rendererChain = rendererControlToLayout(p, options).matrix;
      const canonical = canonicalMatrix(p, options);
      for (const coefficient of ['a', 'b', 'c', 'd', 'e', 'f'] as const) {
        expect(Math.abs(canonical[coefficient] - rendererChain[coefficient])).toBeLessThanOrEqual(
          GEOMETRY_MATRIX_RECONSTRUCTION_TOLERANCE,
        );
      }
    }
  });
});

describe('geometry v2 — projection reconstruction and exact validation (P3, P7)', () => {
  const p = payload({ centerX: 37, radius: 37, radiusY: 20, centerY: 5 });

  it('reconstructs warpControlToSubjectFrame from published facts only', () => {
    const projection = symmetricProjection(p, 11.5, { flipX: true, flipY: false });
    const reconstructed = reconstructWarpControlToSubjectFrame(projection);
    expect(reconstructed).not.toBeNull();
    const translate = translationAffine(
      11.5 - projection.controlBounds.x,
      11.5 - projection.controlBounds.y,
    );
    const signX = -1;
    const flip: Affine2D = {
      a: signX,
      b: 0,
      c: 0,
      d: 1,
      e: signX === -1 ? 2 * projection.subjectFrame.flipCenterX : 0,
      f: 0,
    };
    expect(reconstructed).toEqual(multiplyAffine(flip, translate));
  });

  it('accepts an internally consistent projection with canonical expectations', () => {
    const bounds = boundsOf(p);
    const { projection, warpControlToSubjectFrame } = rendererControlToLayout(p, {
      paddingPx: 6,
      flips: { flipX: true, flipY: true },
      xCoordinate: 3,
      yCoordinate: 4,
      rotationDegrees: 0,
    });
    expect(
      validateCircleTextFrameProjection(projection, {
        expectedControlBounds: bounds,
        expectedFlips: { flipX: true, flipY: true },
        publishedWarpControlToSubjectFrame: warpControlToSubjectFrame,
      }),
    ).toEqual({ ok: true });
  });

  it('accepts a published matrix within 1e-6 and rejects it immediately outside', () => {
    const { projection } = rendererControlToLayout(p, {
      paddingPx: 0,
      flips: NO_FLIPS,
      xCoordinate: 0,
      yCoordinate: 0,
      rotationDegrees: 0,
    });
    const reconstructed = reconstructWarpControlToSubjectFrame(projection) as Affine2D;
    // This payload/padding combination makes the translation coefficient `e`
    // exactly zero, so the tolerance boundary is representable and unambiguous.
    expect(reconstructed.e).toBe(0);
    expect(
      validateCircleTextFrameProjection(projection, {
        publishedWarpControlToSubjectFrame: { ...reconstructed, e: 1e-6 },
      }),
    ).toEqual({ ok: true });
    const outside = validateCircleTextFrameProjection(projection, {
      publishedWarpControlToSubjectFrame: { ...reconstructed, e: 2e-6 },
    });
    expect(outside.ok).toBe(false);
    if (!outside.ok) expect(outside.failure.reason).toBe('MATRIX_RECONSTRUCTION_MISMATCH');
    expect(affineAgreesWithin(reconstructed, { ...reconstructed, e: 1e-6 })).toBe(true);
    expect(affineAgreesWithin(reconstructed, { ...reconstructed, e: 1e-5 })).toBe(false);
  });

  it('fails closed for a missing projection or missing kind', () => {
    const missing = validateCircleTextFrameProjection(undefined);
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.failure.code).toBe('GEOMETRY_TRANSFORM_INVALID');
      expect(missing.failure.reason).toBe('PROJECTION_MISSING');
    }
    const noKind = validateCircleTextFrameProjection({ padding: {} });
    expect(noKind.ok).toBe(false);
    if (!noKind.ok) expect(noKind.failure.reason).toBe('PROJECTION_KIND_MISSING');
  });

  it('fails closed for an unknown future projection kind', () => {
    const result = validateCircleTextFrameProjection({
      ...symmetricProjection(p, 4, NO_FLIPS),
      kind: 'wave-frame-projection-v1',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.code).toBe('GEOMETRY_REPRESENTATION_UNSUPPORTED');
      expect(result.failure.reason).toBe('PROJECTION_KIND_UNSUPPORTED');
    }
  });

  it('fails closed for non-finite or negative padding', () => {
    for (const padding of [
      { left: Number.NaN, right: 1, top: 1, bottom: 1 },
      { left: -1, right: 1, top: 1, bottom: 1 },
      { left: 1, right: 1, top: 1, bottom: Number.POSITIVE_INFINITY },
    ]) {
      const result = validateCircleTextFrameProjection({
        ...symmetricProjection(p, 1, NO_FLIPS),
        padding,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.failure.code).toBe('GEOMETRY_TRANSFORM_INVALID');
        expect(result.failure.reason).toBe('PADDING_INVALID');
      }
    }
  });

  it('fails closed for every individual asymmetric padding side (P2)', () => {
    const base = symmetricProjection(p, 4, NO_FLIPS);
    for (const side of ['left', 'right', 'top', 'bottom'] as const) {
      const projection = {
        ...base,
        padding: { ...base.padding, [side]: base.padding[side] + 1 },
      };
      const result = validateCircleTextFrameProjection(projection);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.failure.code).toBe('GEOMETRY_REPRESENTATION_UNSUPPORTED');
        expect(result.failure.reason).toBe('PADDING_ASYMMETRIC');
      }
    }
  });

  it('fails closed for invalid control/subject-frame dimensions and flip centers', () => {
    const base = symmetricProjection(p, 4, NO_FLIPS);
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ ...base, controlBounds: { ...base.controlBounds, width: 0 } }, 'CONTROL_BOUNDS_INVALID'],
      [
        {
          ...base,
          subjectFrame: { ...base.subjectFrame, width: base.subjectFrame.width + 1 },
        },
        'SUBJECT_FRAME_DIMENSION_MISMATCH',
      ],
      [
        {
          ...base,
          subjectFrame: { ...base.subjectFrame, flipCenterX: base.subjectFrame.flipCenterX + 0.5 },
        },
        'FLIP_CENTER_MISMATCH',
      ],
      [{ ...base, flips: { x: 'yes', y: false } }, 'FLIPS_INVALID'],
    ];
    for (const [projection, reason] of cases) {
      const result = validateCircleTextFrameProjection(projection);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.failure.code).toBe('GEOMETRY_TRANSFORM_INVALID');
        expect(result.failure.reason).toBe(reason);
      }
    }
  });

  it('fails closed when control bounds or semantic flips disagree with canonical state', () => {
    const bounds = boundsOf(p);
    const projection = symmetricProjection(p, 4, { flipX: true, flipY: false });
    const boundsResult = validateCircleTextFrameProjection(projection, {
      expectedControlBounds: { ...bounds, x: bounds.x + 1 },
    });
    expect(boundsResult.ok).toBe(false);
    if (!boundsResult.ok) expect(boundsResult.failure.reason).toBe('CONTROL_BOUNDS_MISMATCH');

    const flipResult = validateCircleTextFrameProjection(projection, {
      expectedFlips: { flipX: false, flipY: false },
    });
    expect(flipResult.ok).toBe(false);
    if (!flipResult.ok) expect(flipResult.failure.reason).toBe('SEMANTIC_FLIP_MISMATCH');
  });

  it('fails closed for a non-finite published matrix', () => {
    const projection = symmetricProjection(p, 4, NO_FLIPS);
    const result = validateCircleTextFrameProjection(projection, {
      publishedWarpControlToSubjectFrame: { ...IDENTITY_AFFINE, a: Number.NaN },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.reason).toBe('MATRIX_INVALID');
  });
});

describe('geometry v2 — outer frame rotation and space composition (R2, R4; tests 5–8)', () => {
  it('maps the subject-frame origin to (frameX, frameY) with no rotation', () => {
    const matrix = subjectFrameToLayoutMatrix({
      frameX: 86,
      frameY: 86,
      frameWidth: 128,
      frameHeight: 128,
      rotationDegrees: 0,
    });
    approxPoint(applyAffine(matrix, { x: 0, y: 0 }), { x: 86, y: 86 });
  });

  it('rotates about the padded frame center after inner translation/flip (test 5)', () => {
    const matrix = subjectFrameToLayoutMatrix({
      frameX: 86,
      frameY: 86,
      frameWidth: 128,
      frameHeight: 128,
      rotationDegrees: 90,
    });
    // Subject-frame point (14,14) sits 50 left/up of the frame center (64,64).
    // A 90° rotation about the frame center maps it to (64+50, 64-50) + frameX/Y.
    approxPoint(applyAffine(matrix, { x: 14, y: 14 }), { x: 150 + 50, y: 150 - 50 });
  });

  it('separates subject-frame, Layout-local and world points for a translated Layout (test 6)', () => {
    const subject = transformQuad(
      reconstructWarpControlToSubjectFrame(
        symmetricProjection(payload(), 14, NO_FLIPS),
      ) as Affine2D,
      canonicalWarpControlQuad(payload()) as Quad,
    );
    const matrix = subjectFrameToLayoutMatrix({
      frameX: 86,
      frameY: 86,
      frameWidth: 148,
      frameHeight: 108,
      rotationDegrees: 0,
    });
    const layoutLocal = transformQuad(matrix, subject);
    const layoutToWorld = translationAffine(560, 0);
    const world = transformQuad(layoutToWorld, layoutLocal);
    expect(layoutLocal[0]).not.toEqual(subject[0]);
    expect(world[0]).not.toEqual(layoutLocal[0]);
    approxPoint(world[0], { x: layoutLocal[0].x + 560, y: layoutLocal[0].y });
  });

  it('composes Stage translation, nonuniform scale, rotation, offset and CSS ratios (test 7)', () => {
    const matrices = {
      warpControlToSubjectFrame: translationAffine(14, 14),
      subjectFrameToLayout: subjectFrameToLayoutMatrix({
        frameX: 0,
        frameY: 0,
        frameWidth: 148,
        frameHeight: 108,
        rotationDegrees: 0,
      }),
      layoutToWorldScene: translationAffine(560, 0),
      worldSceneToStageViewportCss: multiplyAffine(
        translationAffine(30, 20),
        multiplyAffine(
          scaleAffine(0.75, 1.25),
          multiplyAffine(rotationAffine(0.1), scaleAffine(2, 1)),
        ),
      ),
      stageViewportToBrowserClientCss: translationAffine(12, 34),
    } as const;
    const chain = composeChain(matrices);
    const point = applyAffine(chain, { x: 60, y: 40 });
    const independent = multiplyAffine(
      translationAffine(12, 34),
      multiplyAffine(
        translationAffine(30, 20),
        multiplyAffine(
          scaleAffine(0.75, 1.25),
          multiplyAffine(
            rotationAffine(0.1),
            multiplyAffine(scaleAffine(2, 1), translationAffine(574, 14)),
          ),
        ),
      ),
    );
    approxPoint(point, applyAffine(independent, { x: 60, y: 40 }));
  });

  it('applies a container client offset to browser-client points only (test 8)', () => {
    const base = composeChain({
      warpControlToSubjectFrame: IDENTITY_AFFINE,
      subjectFrameToLayout: IDENTITY_AFFINE,
      layoutToWorldScene: IDENTITY_AFFINE,
      worldSceneToStageViewportCss: IDENTITY_AFFINE,
      stageViewportToBrowserClientCss: IDENTITY_AFFINE,
    });
    const offset = composeChain({
      warpControlToSubjectFrame: IDENTITY_AFFINE,
      subjectFrameToLayout: IDENTITY_AFFINE,
      layoutToWorldScene: IDENTITY_AFFINE,
      worldSceneToStageViewportCss: IDENTITY_AFFINE,
      stageViewportToBrowserClientCss: translationAffine(7, -3),
    });
    approxPoint(applyAffine(base, { x: 1, y: 2 }), { x: 1, y: 2 });
    approxPoint(applyAffine(offset, { x: 1, y: 2 }), { x: 8, y: -1 });
  });
});

describe('geometry v2 — winding, reflection and AABB insufficiency (R1; tests 9–10)', () => {
  const convex: Quad = [
    { x: 3, y: 5 },
    { x: 13, y: 5 },
    { x: 13, y: 9 },
    { x: 3, y: 9 },
  ];

  it('preserves semantic indexes and reverses winding only by determinant parity (test 9)', () => {
    const reflected = transformQuad(scaleAffine(-1, 1), convex);
    for (let index = 0; index < 4; index += 1) {
      approxPoint(reflected[index], { x: -convex[index].x, y: convex[index].y });
    }
    expect(quadWindingSign(convex)).toBe(1);
    expect(quadWindingSign(reflected)).toBe(-1);
    expect(quadWindingSign(reflected)).toBe(determinantParity(scaleAffine(-1, 1)));
    expect(quadIsConvex(reflected)).toBe(true);
    expect(quadIsSimple(reflected)).toBe(true);
  });

  it('proves AABB insufficiency: equal bounds, different corresponding quads (test 10)', () => {
    const rotated = transformQuad(rotationAffine(Math.PI / 4), convex);
    const bounds = (quad: Quad) => {
      const xs = quad.map((point) => point.x);
      const ys = quad.map((point) => point.y);
      return {
        minX: Math.min(...xs),
        maxX: Math.max(...xs),
        minY: Math.min(...ys),
        maxY: Math.max(...ys),
      };
    };
    const mirrored: Quad = [
      { x: 13, y: 5 },
      { x: 3, y: 5 },
      { x: 3, y: 9 },
      { x: 13, y: 9 },
    ];
    expect(bounds(mirrored)).toEqual(bounds(convex));
    expect(mirrored).not.toEqual(convex);
    expect(quadWindingSign(mirrored)).toBe(-1);
    expect(quadArea(rotated)).toBeCloseTo(quadArea(convex), 9);
  });

  it('detects non-convex and self-intersecting quads', () => {
    const bowTie: Quad = [
      { x: 0, y: 0 },
      { x: 10, y: 10 },
      { x: 10, y: 0 },
      { x: 0, y: 10 },
    ];
    expect(quadIsSimple(bowTie)).toBe(false);
    expect(quadSelfIntersects(bowTie)).toBe(true);
    expect(eligibleHitPointCandidates(bowTie)).toEqual([]);
  });
});

describe('geometry v2 — affine arithmetic', () => {
  it('inverts a finite transform and rejects a singular one', () => {
    const matrix = multiplyAffine(translationAffine(5, -7), scaleAffine(2, 3));
    const inverse = invertAffine(matrix);
    expect(inverse).not.toBeNull();
    const point = { x: 11, y: -4 };
    approxPoint(applyAffine(inverse as Affine2D, applyAffine(matrix, point)), point);
    expect(invertAffine(scaleAffine(0, 1))).toBeNull();
  });

  it('strips translation from the linear part used for delta conversion', () => {
    expect(linearPart(multiplyAffine(translationAffine(9, 9), scaleAffine(2, 4)))).toEqual({
      a: 2,
      b: 0,
      c: 0,
      d: 4,
      e: 0,
      f: 0,
    });
  });
});

describe('geometry v2 — hit-point candidate construction (R8; tests 16–17)', () => {
  const square: Quad = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 100 },
    { x: 0, y: 100 },
  ];

  it('keeps the deterministic candidate order (test 16)', () => {
    const candidates = eligibleHitPointCandidates(square);
    expect(candidates.map((candidate) => candidate.label)).toEqual([
      'center',
      'top-left',
      'top-right',
      'bottom-right',
      'bottom-left',
    ]);
    approxPoint(candidates[0].point, quadCentroid(square));
    approxPoint(candidates[1].point, bilinearPoint(square, 0.25, 0.25));
  });

  it('requires at least 4 CSS px from every edge (test 17)', () => {
    const thin: Quad = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 6 },
      { x: 0, y: 6 },
    ];
    expect(eligibleHitPointCandidates(thin)).toEqual([]);
    const inset = HIT_POINT_INSET_CSS_PX;
    const safe: Quad = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: inset * 2 + 1 },
      { x: 0, y: inset * 2 + 1 },
    ];
    const candidates = eligibleHitPointCandidates(safe);
    expect(candidates.length).toBeGreaterThan(0);
    for (const candidate of candidates) {
      expect(distanceToQuadEdges(candidate.point, safe)).toBeGreaterThanOrEqual(inset);
      expect(pointInConvexQuad(candidate.point, safe)).toBe(true);
    }
  });

  it('admits exactly 4 CSS px and rejects immediately below the inset (test 17)', () => {
    const inset = HIT_POINT_INSET_CSS_PX;
    const height = inset * 2;
    const exactly: Quad = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: height },
      { x: 0, y: height },
    ];
    const admitted = eligibleHitPointCandidates(exactly);
    const boundary = admitted.find((candidate) => candidate.label === 'center');
    expect(boundary).toBeDefined();
    expect(boundary?.edgeDistance).toBeCloseTo(inset, 12);
    expect(distanceToQuadEdges(boundary?.point ?? { x: 0, y: 0 }, exactly)).toBeGreaterThanOrEqual(
      inset,
    );

    const immediatelyBelow: Quad = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: height - 1e-6 },
      { x: 0, y: height - 1e-6 },
    ];
    expect(eligibleHitPointCandidates(immediatelyBelow)).toEqual([]);
  });

  it('excludes points outside a skewed convex quad rather than guessing', () => {
    const skewed: Quad = [
      { x: 0, y: 0 },
      { x: 40, y: 0 },
      { x: 70, y: 30 },
      { x: 30, y: 30 },
    ];
    for (const candidate of eligibleHitPointCandidates(skewed)) {
      expect(pointInConvexQuad(candidate.point, skewed)).toBe(true);
    }
  });
});

describe('geometry v2 — fingerprints are opaque determinism facts (R7, P5; test 15)', () => {
  function representationFor(
    p: CircleWarpPayloadInput,
    options: RendererChainOptions,
  ): Omit<CircleControlEnvelopeQuadV1, 'representationFingerprint' | 'warpFingerprint'> {
    const { projection, warpControlToSubjectFrame } = rendererControlToLayout(p, options);
    const raw = canonicalWarpControlQuad(p) as Quad;
    const subjectFrameLocal = transformQuad(warpControlToSubjectFrame, raw);
    const layoutLocal = transformQuad(
      canonicalCircleControlToLayoutMatrix({
        payload: p,
        xCoordinate: options.xCoordinate,
        yCoordinate: options.yCoordinate,
        rotationDegrees: options.rotationDegrees,
        flipX: options.flips.flipX,
        flipY: options.flips.flipY,
      }) as Affine2D,
      raw,
    );
    return {
      kind: CIRCLE_CONTROL_ENVELOPE_KIND,
      pointOrder: CIRCLE_CONTROL_ENVELOPE_POINT_ORDER,
      warpType: 'circle',
      units: GEOMETRY_SPACE_UNITS,
      projection,
      warpControlLocal: raw,
      subjectFrameLocal,
      layoutLocal,
      worldScene: layoutLocal,
      stageViewportCss: layoutLocal,
      browserClientCss: layoutLocal,
      matrices: {
        warpControlToSubjectFrame,
        subjectFrameToLayout: IDENTITY_AFFINE,
        layoutToWorldScene: IDENTITY_AFFINE,
        worldSceneToStageViewportCss: IDENTITY_AFFINE,
        stageViewportToBrowserClientCss: IDENTITY_AFFINE,
      },
    };
  }

  const baseOptions: RendererChainOptions = {
    paddingPx: 9,
    flips: { flipX: true, flipY: false },
    xCoordinate: 20,
    yCoordinate: 30,
    rotationDegrees: 15,
  };

  function fingerprint(
    representation: Omit<
      CircleControlEnvelopeQuadV1,
      'representationFingerprint' | 'warpFingerprint'
    >,
  ): string {
    return computeRepresentationFingerprint({
      representation,
      targetId: 'layer-a-text-1',
      layoutId: 'layout-a',
      cssRatios: { x: 1.25, y: 0.75 },
      bridgeGeneration: 7,
      warpFingerprint: computeCircleWarpFingerprint(payload()),
    });
  }

  it('is stable under object-key order and normalizes -0', () => {
    const a = payload({ centerX: -0, rotationAngle: 0 });
    const b: CircleWarpPayloadInput = {
      arcAlign: 'end',
      arcLength: 0,
      inverted: false,
      radius: 60,
      radiusY: 40,
      verticalAlign: 'center',
      rotationAngle: -0,
      centerY: 40,
      centerX: 0,
    };
    expect(computeCircleWarpFingerprint(a)).toBe(computeCircleWarpFingerprint(b));
  });

  it('changes when any circle payload field changes', () => {
    const base = computeCircleWarpFingerprint(payload());
    expect(computeCircleWarpFingerprint(payload({ centerX: 61 }))).not.toBe(base);
    expect(computeCircleWarpFingerprint(payload({ radius: 61 }))).not.toBe(base);
    expect(computeCircleWarpFingerprint(payload({ inverted: true }))).not.toBe(base);
    expect(computeCircleWarpFingerprint(payload({ arcAlign: 'start' }))).not.toBe(base);
    expect(computeCircleWarpFingerprint(payload({ verticalAlign: 'top' }))).not.toBe(base);
    expect(computeCircleWarpFingerprint(payload({ arcLength: 0.5 }))).not.toBe(base);
    expect(computeCircleWarpFingerprint(payload({ rotationAngle: 0 }))).not.toBe(base);
    expect(computeCircleWarpFingerprint(payload({ radiusY: 41 }))).not.toBe(base);
    expect(computeCircleWarpFingerprint(payload({ centerY: 41 }))).not.toBe(base);
  });

  it('rejects a non-finite payload value instead of hashing NaN', () => {
    expect(() => computeCircleWarpFingerprint(payload({ centerX: Number.NaN }))).toThrow();
    expect(() =>
      computeCircleWarpFingerprint(payload({ radius: Number.POSITIVE_INFINITY })),
    ).toThrow();
  });

  it('mutates for every projection field (P5)', () => {
    const p = payload();
    const base = representationFor(p, baseOptions);
    const baseFingerprint = fingerprint(base);
    const projection = base.projection;

    const mutations: Array<CircleTextFrameProjectionV1> = [
      { ...projection, kind: 'wave-frame-projection-v1' as never },
      { ...projection, padding: { ...projection.padding, left: projection.padding.left + 0.5 } },
      { ...projection, padding: { ...projection.padding, right: projection.padding.right + 0.5 } },
      { ...projection, padding: { ...projection.padding, top: projection.padding.top + 0.5 } },
      {
        ...projection,
        padding: { ...projection.padding, bottom: projection.padding.bottom + 0.5 },
      },
      {
        ...projection,
        controlBounds: { ...projection.controlBounds, x: projection.controlBounds.x + 0.5 },
      },
      {
        ...projection,
        controlBounds: { ...projection.controlBounds, y: projection.controlBounds.y + 0.5 },
      },
      {
        ...projection,
        controlBounds: { ...projection.controlBounds, width: projection.controlBounds.width + 0.5 },
      },
      {
        ...projection,
        controlBounds: {
          ...projection.controlBounds,
          height: projection.controlBounds.height + 0.5,
        },
      },
      {
        ...projection,
        subjectFrame: { ...projection.subjectFrame, width: projection.subjectFrame.width + 0.5 },
      },
      {
        ...projection,
        subjectFrame: { ...projection.subjectFrame, height: projection.subjectFrame.height + 0.5 },
      },
      {
        ...projection,
        subjectFrame: {
          ...projection.subjectFrame,
          flipCenterX: projection.subjectFrame.flipCenterX + 0.5,
        },
      },
      {
        ...projection,
        subjectFrame: {
          ...projection.subjectFrame,
          flipCenterY: projection.subjectFrame.flipCenterY + 0.5,
        },
      },
      { ...projection, flips: { ...projection.flips, x: !projection.flips.x } },
      { ...projection, flips: { ...projection.flips, y: !projection.flips.y } },
    ];

    const seen = new Set([baseFingerprint]);
    for (const mutation of mutations) {
      const mutated = fingerprint({ ...base, projection: mutation });
      expect(mutated).not.toBe(baseFingerprint);
      expect(seen.has(mutated)).toBe(false);
      seen.add(mutated);
    }
  });

  it('mutates for point, matrix, ratio and generation changes only', () => {
    const p = payload();
    const base = representationFor(p, baseOptions);
    const baseFingerprint = computeRepresentationFingerprint({
      representation: base,
      targetId: 'layer-a-text-1',
      layoutId: 'layout-a',
      cssRatios: { x: 1.25, y: 0.75 },
      bridgeGeneration: 7,
      warpFingerprint: computeCircleWarpFingerprint(p),
    });
    const movedPoint = {
      ...base,
      browserClientCss: transformQuad(translationAffine(0.5, 0), base.browserClientCss) as Quad,
    };
    expect(
      computeRepresentationFingerprint({
        representation: movedPoint,
        targetId: 'layer-a-text-1',
        layoutId: 'layout-a',
        cssRatios: { x: 1.25, y: 0.75 },
        bridgeGeneration: 7,
        warpFingerprint: computeCircleWarpFingerprint(p),
      }),
    ).not.toBe(baseFingerprint);
    expect(
      computeRepresentationFingerprint({
        representation: base,
        targetId: 'layer-a-text-1',
        layoutId: 'layout-a',
        cssRatios: { x: 1.25, y: 0.750_1 },
        bridgeGeneration: 7,
        warpFingerprint: computeCircleWarpFingerprint(p),
      }),
    ).not.toBe(baseFingerprint);
    expect(
      computeRepresentationFingerprint({
        representation: base,
        targetId: 'layer-a-text-1',
        layoutId: 'layout-a',
        cssRatios: { x: 1.25, y: 0.75 },
        bridgeGeneration: 8,
        warpFingerprint: computeCircleWarpFingerprint(p),
      }),
    ).not.toBe(baseFingerprint);
  });

  it('mutates for every point array, matrix, identity and warp fingerprint (R7, P5)', () => {
    const p = payload();
    const base = representationFor(p, baseOptions);
    const baseInput = {
      representation: base,
      targetId: 'layer-a-text-1',
      layoutId: 'layout-a',
      cssRatios: { x: 1.25, y: 0.75 },
      bridgeGeneration: 7,
      warpFingerprint: computeCircleWarpFingerprint(p),
    };
    const baseFingerprint = computeRepresentationFingerprint(baseInput);
    const spaceKeys = [
      'warpControlLocal',
      'subjectFrameLocal',
      'layoutLocal',
      'worldScene',
      'stageViewportCss',
      'browserClientCss',
    ] as const;

    const mutatedFingerprints: string[] = [];
    for (const space of spaceKeys) {
      const mutated = {
        ...base,
        [space]: transformQuad(translationAffine(0.5, 0.5), base[space]) as Quad,
      };
      mutatedFingerprints.push(
        computeRepresentationFingerprint({ ...baseInput, representation: mutated }),
      );
    }
    for (const key of GEOMETRY_MATRIX_KEYS) {
      const mutated = {
        ...base,
        matrices: {
          ...base.matrices,
          [key]: { ...base.matrices[key], e: base.matrices[key].e + 0.5 },
        },
      };
      mutatedFingerprints.push(
        computeRepresentationFingerprint({ ...baseInput, representation: mutated }),
      );
    }
    mutatedFingerprints.push(
      computeRepresentationFingerprint({ ...baseInput, targetId: 'layer-a-text-2' }),
    );
    mutatedFingerprints.push(
      computeRepresentationFingerprint({ ...baseInput, layoutId: 'layout-b' }),
    );
    mutatedFingerprints.push(
      computeRepresentationFingerprint({
        ...baseInput,
        warpFingerprint: computeCircleWarpFingerprint(payload({ arcAlign: 'start' })),
      }),
    );

    expect(mutatedFingerprints).toHaveLength(spaceKeys.length + GEOMETRY_MATRIX_KEYS.length + 3);
    const seen = new Set([baseFingerprint]);
    for (const fingerprintValue of mutatedFingerprints) {
      expect(fingerprintValue).not.toBe(baseFingerprint);
      expect(seen.has(fingerprintValue)).toBe(false);
      seen.add(fingerprintValue);
    }
    // The same input is deterministic and stable.
    expect(computeRepresentationFingerprint(baseInput)).toBe(baseFingerprint);
  });
});

describe('geometry v2 — typed validation fails closed (R6, R14, P3, P7; test 13)', () => {
  const options: RendererChainOptions = {
    paddingPx: 6,
    flips: { flipX: true, flipY: false },
    xCoordinate: 40,
    yCoordinate: 50,
    rotationDegrees: 20,
  };

  function validRepresentation() {
    const { projection, warpControlToSubjectFrame } = rendererControlToLayout(payload(), options);
    const raw = canonicalWarpControlQuad(payload()) as Quad;
    const subjectFrameLocal = transformQuad(warpControlToSubjectFrame, raw);
    const layoutLocal = transformQuad(
      canonicalCircleControlToLayoutMatrix({
        payload: payload(),
        xCoordinate: options.xCoordinate,
        yCoordinate: options.yCoordinate,
        rotationDegrees: options.rotationDegrees,
        flipX: options.flips.flipX,
        flipY: options.flips.flipY,
      }) as Affine2D,
      raw,
    );
    return {
      kind: CIRCLE_CONTROL_ENVELOPE_KIND,
      pointOrder: CIRCLE_CONTROL_ENVELOPE_POINT_ORDER,
      warpType: 'circle' as const,
      units: GEOMETRY_SPACE_UNITS,
      projection,
      warpControlLocal: raw,
      subjectFrameLocal,
      layoutLocal,
      worldScene: layoutLocal,
      stageViewportCss: layoutLocal,
      browserClientCss: layoutLocal,
      matrices: {
        ...Object.fromEntries(GEOMETRY_MATRIX_KEYS.map((key) => [key, IDENTITY_AFFINE])),
        warpControlToSubjectFrame,
      },
      warpFingerprint: computeCircleWarpFingerprint(payload()),
      representationFingerprint: 'deadbeefdeadbeef',
    };
  }

  const validProvenance = {
    schemaVersion: 2 as const,
    bridgeGeneration: 1,
    stageFingerprint: 'stage',
    target: {
      id: 'layer-a-text-1',
      konvaId: 'layer-a-text-1',
      nodeClass: 'Group',
      subjectFrameToLayout: IDENTITY_AFFINE,
      fingerprint: 'target',
    },
    layout: {
      id: 'layout-a',
      konvaId: 'layout-layout-a',
      nodeClass: 'Group',
      layoutToWorldScene: IDENTITY_AFFINE,
      fingerprint: 'layout',
    },
    representationFingerprint: 'deadbeefdeadbeef',
  };

  it('accepts a well-formed schema-v2 record', () => {
    expect(
      validateTypedGeometry({
        schemaVersion: GEOMETRY_SCHEMA_VERSION,
        representation: validRepresentation(),
        provenance: validProvenance,
        ratios: { x: 1, y: 2 },
      }),
    ).toEqual({ ok: true });
  });

  it('accepts canonical expectations and rejects their disagreement', () => {
    const bounds = boundsOf(payload());
    expect(
      validateTypedGeometry({
        schemaVersion: GEOMETRY_SCHEMA_VERSION,
        representation: validRepresentation(),
        provenance: validProvenance,
        ratios: { x: 1, y: 2 },
        expectedControlBounds: bounds,
        expectedFlips: options.flips,
      }),
    ).toEqual({ ok: true });
    const mismatch = validateTypedGeometry({
      schemaVersion: GEOMETRY_SCHEMA_VERSION,
      representation: validRepresentation(),
      provenance: validProvenance,
      ratios: { x: 1, y: 2 },
      expectedFlips: { flipX: true, flipY: true },
    });
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) expect(mismatch.failure.reason).toBe('SEMANTIC_FLIP_MISMATCH');
  });

  it('rejects a wrong schema or representation kind', () => {
    let result = validateTypedGeometry({
      schemaVersion: 1,
      representation: validRepresentation(),
      provenance: validProvenance,
      ratios: { x: 1, y: 2 },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.code).toBe('GEOMETRY_REPRESENTATION_UNSUPPORTED');

    result = validateTypedGeometry({
      schemaVersion: GEOMETRY_SCHEMA_VERSION,
      representation: { ...validRepresentation(), kind: 'aabb-rect-v1' },
      provenance: validProvenance,
      ratios: { x: 1, y: 2 },
    });
    expect(result.ok).toBe(false);
  });

  it('rejects a missing or malformed projection', () => {
    const missing = validateTypedGeometry({
      schemaVersion: GEOMETRY_SCHEMA_VERSION,
      representation: { ...validRepresentation(), projection: undefined },
      provenance: validProvenance,
      ratios: { x: 1, y: 2 },
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.failure.code).toBe('GEOMETRY_TRANSFORM_INVALID');
      expect(missing.failure.reason).toBe('PROJECTION_MISSING');
    }

    const asymmetric = validateTypedGeometry({
      schemaVersion: GEOMETRY_SCHEMA_VERSION,
      representation: {
        ...validRepresentation(),
        projection: {
          ...symmetricProjection(payload(), 6, options.flips),
          padding: { left: 6, right: 7, top: 6, bottom: 6 },
        },
      },
      provenance: validProvenance,
      ratios: { x: 1, y: 2 },
    });
    expect(asymmetric.ok).toBe(false);
    if (!asymmetric.ok) {
      expect(asymmetric.failure.code).toBe('GEOMETRY_REPRESENTATION_UNSUPPORTED');
      expect(asymmetric.failure.reason).toBe('PADDING_ASYMMETRIC');
    }
  });

  it('rejects reordered points and wrong units', () => {
    let result = validateTypedGeometry({
      schemaVersion: GEOMETRY_SCHEMA_VERSION,
      representation: {
        ...validRepresentation(),
        pointOrder: [...CIRCLE_CONTROL_ENVELOPE_POINT_ORDER].reverse(),
      },
      provenance: validProvenance,
      ratios: { x: 1, y: 2 },
    });
    expect(result.ok).toBe(false);

    result = validateTypedGeometry({
      schemaVersion: GEOMETRY_SCHEMA_VERSION,
      representation: {
        ...validRepresentation(),
        units: { ...GEOMETRY_SPACE_UNITS, warpControlLocal: 'css-px' },
      },
      provenance: validProvenance,
      ratios: { x: 1, y: 2 },
    });
    expect(result.ok).toBe(false);
  });

  it('rejects non-finite points/matrices, invalid ratios, and missing identity', () => {
    let result = validateTypedGeometry({
      schemaVersion: GEOMETRY_SCHEMA_VERSION,
      representation: {
        ...validRepresentation(),
        browserClientCss: [
          { x: Number.NaN, y: 0 },
          ...validRepresentation().browserClientCss.slice(1),
        ],
      },
      provenance: validProvenance,
      ratios: { x: 1, y: 2 },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.code).toBe('GEOMETRY_TRANSFORM_INVALID');

    result = validateTypedGeometry({
      schemaVersion: GEOMETRY_SCHEMA_VERSION,
      representation: validRepresentation(),
      provenance: {
        ...validProvenance,
        target: {
          ...validProvenance.target,
          subjectFrameToLayout: { ...IDENTITY_AFFINE, a: Number.NaN },
        },
      },
      ratios: { x: 1, y: 2 },
    });
    expect(result.ok).toBe(false);

    for (const ratios of [
      { x: 0, y: 1 },
      { x: 1, y: -1 },
      { x: Number.NaN, y: 1 },
    ]) {
      result = validateTypedGeometry({
        schemaVersion: GEOMETRY_SCHEMA_VERSION,
        representation: validRepresentation(),
        provenance: validProvenance,
        ratios,
      });
      expect(result.ok).toBe(false);
    }

    result = validateTypedGeometry({
      schemaVersion: GEOMETRY_SCHEMA_VERSION,
      representation: validRepresentation(),
      provenance: { ...validProvenance, layout: undefined },
      ratios: { x: 1, y: 2 },
    });
    expect(result.ok).toBe(false);
  });
});
