/**
 * Typed circle-warp geometry contract (WP5 Slice 5-B; supervisor R1–R9 + P1–P9).
 *
 * This module is the toolkit-side, pure, product-free authority for the
 * `circle-control-envelope-quad-v1` representation and the geometry schema v2
 * that bridge v4 exposes. It is currently **runtime-inert** Phase A scaffolding:
 * its only consumer is its focused foundation test, it is not exported from the
 * active toolkit entry point, and no bridge, Doctor, adapter, readiness, Oracle,
 * observation, catalogue, or CLI module imports it.
 *
 * It defines:
 *
 *  - the fixed semantic point order (`top-left → top-right → bottom-right →
 *    bottom-left`) that is never resorted after rotation, skew, reflection, or
 *    space conversion (R1);
 *  - the six declared spaces and five matrices of the correction coordinate
 *    chain (R2, R3);
 *  - a typed circle frame-projection record (`circle-text-frame-projection-v1`)
 *    that carries renderer-published facts, and an exact validator plus a
 *    reconstruction of `warpControlToSubjectFrame` from those published facts
 *    (P3) — the projection is renderer provenance, never canonical intent;
 *  - the padding-free canonical `controlToLayout` matrix (P1, P4), which relies
 *    on the symmetric-padding cancellation invariant and therefore contains no
 *    product circle or shadow-padding constant or formula;
 *  - pure affine and quad arithmetic: composition, inversion, area, convexity,
 *    self-intersection, winding parity, corner correspondence, and hit-point
 *    candidacy (R1, R8);
 *  - canonical raw circle-control construction derived independently from the
 *    authoritative payload (R5);
 *  - opaque, versioned, deterministic warp and representation fingerprints
 *    whose preimages include the projection fields (R7, P5).
 *
 * Nothing here parses a fingerprint for semantic fields, and nothing here is a
 * fallback for a missing bridge geometry source. The toolkit must never import,
 * copy, infer, or parameterize the product's circle or shadow-padding formula;
 * the renderer's sole frame-padding authority is the product helper the bridge
 * calls in Phase B.
 */

// ── Versions and vocabularies ───────────────────────────────────────────────

/** Observation bridge contract version for Slice 5-B. */
export const GEOMETRY_BRIDGE_VERSION = 4;

/** Typed geometry schema version exposed by bridge v4. */
export const GEOMETRY_SCHEMA_VERSION = 2;

/** The one representation kind this slice authorizes. */
export const CIRCLE_CONTROL_ENVELOPE_KIND = 'circle-control-envelope-quad-v1';

/** The one typed frame-projection kind this slice authorizes (P3). */
export const CIRCLE_TEXT_FRAME_PROJECTION_KIND = 'circle-text-frame-projection-v1';

/**
 * Permanent semantic source order. The labels describe the untransformed circle
 * payload control box; they are never resorted after any transform.
 */
export const CIRCLE_CONTROL_ENVELOPE_POINT_ORDER = [
  'top-left',
  'top-right',
  'bottom-right',
  'bottom-left',
] as const;
export type CircleControlEnvelopePointLabel = (typeof CIRCLE_CONTROL_ENVELOPE_POINT_ORDER)[number];

/** Truthful units per declared space (R3). */
export const GEOMETRY_SPACE_UNITS = Object.freeze({
  warpControlLocal: 'artwork-unit',
  subjectFrameLocal: 'artwork-unit',
  layoutLocal: 'artwork-unit',
  worldScene: 'scene-unit',
  stageViewportCss: 'css-px',
  browserClientCss: 'css-px',
});

/** The six declared geometry spaces in correction-chain order. */
export const GEOMETRY_SPACES = [
  'warpControlLocal',
  'subjectFrameLocal',
  'layoutLocal',
  'worldScene',
  'stageViewportCss',
  'browserClientCss',
] as const;
export type GeometrySpace = (typeof GEOMETRY_SPACES)[number];

/** The five matrices that compose the chain between the six spaces. */
export const GEOMETRY_MATRIX_KEYS = [
  'warpControlToSubjectFrame',
  'subjectFrameToLayout',
  'layoutToWorldScene',
  'worldSceneToStageViewportCss',
  'stageViewportToBrowserClientCss',
] as const;
export type GeometryMatrixKey = (typeof GEOMETRY_MATRIX_KEYS)[number];

/** Algorithm and version of every geometry fingerprint (R7). */
export const GEOMETRY_FINGERPRINT_ALGORITHM = 'fnv1a64';
export const WARP_FINGERPRINT_PREIMAGE_VERSION = 'makeit.warp-fingerprint.circle.v1';
export const REPRESENTATION_FINGERPRINT_PREIMAGE_VERSION = 'makeit.geometry-representation.v2';

/**
 * Coefficient tolerance for the reconstructed-vs-published
 * `warpControlToSubjectFrame` comparison (P3), and the tighter epsilon for pure
 * canonical arithmetic such as projection dimension identities (R13).
 */
export const GEOMETRY_MATRIX_RECONSTRUCTION_TOLERANCE = 1e-6;
export const GEOMETRY_CANONICAL_ARITHMETIC_EPSILON = 1e-9;

// ── Types ───────────────────────────────────────────────────────────────────

export interface GeometryPoint {
  x: number;
  y: number;
}

/** A 2D affine matrix in Konva/DOM order: x' = a·x + c·y + e, y' = b·x + d·y + f. */
export interface Affine2D {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

/** Four corresponding points in permanent semantic order. */
export type Quad = readonly [GeometryPoint, GeometryPoint, GeometryPoint, GeometryPoint];

/** The canonical circle payload fields, in fixed fingerprint order (R7). */
export const CIRCLE_WARP_PAYLOAD_FIELDS = [
  'centerX',
  'centerY',
  'radius',
  'radiusY',
  'rotationAngle',
  'arcLength',
  'inverted',
  'verticalAlign',
  'arcAlign',
] as const;

export interface CircleWarpPayloadInput {
  centerX: number;
  centerY: number;
  radius: number;
  radiusY: number | null;
  rotationAngle: number;
  arcLength: number;
  inverted: boolean;
  verticalAlign: string;
  arcAlign: string;
}

/**
 * Renderer-published circle frame-projection provenance (P3).
 *
 * Every field is a fact the bridge reports about how the live renderer maps the
 * raw circle control box into the padded subject frame. The toolkit validates it
 * but never uses `padding` to build the canonical expected Layout-local result
 * (P4).
 */
export interface CircleTextFrameProjectionV1 {
  kind: typeof CIRCLE_TEXT_FRAME_PROJECTION_KIND;

  padding: {
    left: number;
    right: number;
    top: number;
    bottom: number;
  };

  controlBounds: {
    x: number;
    y: number;
    width: number;
    height: number;
  };

  subjectFrame: {
    width: number;
    height: number;
    flipCenterX: number;
    flipCenterY: number;
  };

  flips: {
    x: boolean;
    y: boolean;
  };
}

export interface CircleControlEnvelopeQuadV1 {
  kind: typeof CIRCLE_CONTROL_ENVELOPE_KIND;
  pointOrder: typeof CIRCLE_CONTROL_ENVELOPE_POINT_ORDER;
  warpType: 'circle';
  units: typeof GEOMETRY_SPACE_UNITS;

  /** Renderer-published frame projection; required (P3). */
  projection: CircleTextFrameProjectionV1;

  warpControlLocal: Quad;
  subjectFrameLocal: Quad;
  layoutLocal: Quad;
  worldScene: Quad;
  stageViewportCss: Quad;
  browserClientCss: Quad;

  matrices: Record<GeometryMatrixKey, Affine2D>;

  warpFingerprint: string;
  representationFingerprint: string;
}

export interface TypedRendererProvenanceV2 {
  schemaVersion: 2;
  bridgeGeneration: number;
  stageFingerprint: string;
  target: {
    id: string;
    konvaId: string;
    nodeClass: string;
    subjectFrameToLayout: Affine2D;
    fingerprint: string;
  };
  layout: {
    id: string;
    konvaId: string;
    nodeClass: string;
    layoutToWorldScene: Affine2D;
    fingerprint: string;
  };
  representationFingerprint: string;
}

export interface TypedGeometryResult {
  schemaVersion: 2;
  typedProvenance: TypedRendererProvenanceV2;
  representation: CircleControlEnvelopeQuadV1;
  /** Independently measured canvas-to-CSS ratios used by the Stage conversion. */
  cssRatios: { x: number; y: number };
}

export interface GeometryContractFailure {
  code:
    | 'GEOMETRY_REPRESENTATION_UNSUPPORTED'
    | 'GEOMETRY_TARGET_ID_MISMATCH'
    | 'GEOMETRY_LAYOUT_ID_MISMATCH'
    | 'GEOMETRY_TRANSFORM_INVALID'
    | 'HIT_POINT_UNAVAILABLE';
  detail: string;
  /** Precise structured cause, e.g. `PADDING_ASYMMETRIC`, `FLIP_CENTER_MISMATCH` (P7). */
  reason: string;
  context: Readonly<Record<string, string>>;
}

export type GeometryValidation = { ok: true } | { ok: false; failure: GeometryContractFailure };

// ── Finite-number discipline ────────────────────────────────────────────────

/** Normalizes an authorable number: reject NaN/infinities, collapse `-0` to `0`. */
export function normalizeFiniteNumber(value: number): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Object.is(value, -0) ? 0 : value;
}

export function isFinitePoint(point: GeometryPoint): boolean {
  return Number.isFinite(point.x) && Number.isFinite(point.y);
}

export function isFiniteAffine(matrix: Affine2D): boolean {
  return (
    Number.isFinite(matrix.a) &&
    Number.isFinite(matrix.b) &&
    Number.isFinite(matrix.c) &&
    Number.isFinite(matrix.d) &&
    Number.isFinite(matrix.e) &&
    Number.isFinite(matrix.f)
  );
}

const AFFINE_COEFFICIENTS = ['a', 'b', 'c', 'd', 'e', 'f'] as const;

/** Coefficient-by-coefficient affine comparison within a tolerance (P3, R13). */
export function affineAgreesWithin(
  left: Affine2D,
  right: Affine2D,
  tolerance: number = GEOMETRY_MATRIX_RECONSTRUCTION_TOLERANCE,
): boolean {
  if (!isFiniteAffine(left) || !isFiniteAffine(right)) return false;
  return AFFINE_COEFFICIENTS.every(
    (coefficient) => Math.abs(left[coefficient] - right[coefficient]) <= tolerance,
  );
}

// ── Affine arithmetic ───────────────────────────────────────────────────────

export const IDENTITY_AFFINE: Affine2D = Object.freeze({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });

export function translationAffine(tx: number, ty: number): Affine2D {
  return { a: 1, b: 0, c: 0, d: 1, e: tx, f: ty };
}

export function scaleAffine(sx: number, sy: number): Affine2D {
  return { a: sx, b: 0, c: 0, d: sy, e: 0, f: 0 };
}

export function rotationAffine(radians: number): Affine2D {
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return { a: cos, b: sin, c: -sin, d: cos, e: 0, f: 0 };
}

/** `outer ∘ inner`: apply `inner` first, then `outer`. */
export function multiplyAffine(outer: Affine2D, inner: Affine2D): Affine2D {
  return {
    a: outer.a * inner.a + outer.c * inner.b,
    b: outer.b * inner.a + outer.d * inner.b,
    c: outer.a * inner.c + outer.c * inner.d,
    d: outer.b * inner.c + outer.d * inner.d,
    e: outer.a * inner.e + outer.c * inner.f + outer.e,
    f: outer.b * inner.e + outer.d * inner.f + outer.f,
  };
}

export function determinantAffine(matrix: Affine2D): number {
  return matrix.a * matrix.d - matrix.b * matrix.c;
}

/** `+1`, `-1`, or `0` — the orientation parity a transform contributes. */
export function determinantParity(matrix: Affine2D): -1 | 0 | 1 {
  const determinant = determinantAffine(matrix);
  if (determinant > 0) return 1;
  if (determinant < 0) return -1;
  return 0;
}

/** Inverts an affine matrix; `null` for a non-invertible (zero-determinant) map. */
export function invertAffine(matrix: Affine2D): Affine2D | null {
  const determinant = determinantAffine(matrix);
  if (!Number.isFinite(determinant) || determinant === 0) return null;
  return {
    a: matrix.d / determinant,
    b: -matrix.b / determinant,
    c: -matrix.c / determinant,
    d: matrix.a / determinant,
    e: (matrix.c * matrix.f - matrix.d * matrix.e) / determinant,
    f: (matrix.b * matrix.e - matrix.a * matrix.f) / determinant,
  };
}

export function applyAffine(matrix: Affine2D, point: GeometryPoint): GeometryPoint {
  return {
    x: matrix.a * point.x + matrix.c * point.y + matrix.e,
    y: matrix.b * point.x + matrix.d * point.y + matrix.f,
  };
}

/** Applies one affine map to all four corresponding points, preserving order. */
export function transformQuad(matrix: Affine2D, quad: Quad): Quad {
  return [
    applyAffine(matrix, quad[0]),
    applyAffine(matrix, quad[1]),
    applyAffine(matrix, quad[2]),
    applyAffine(matrix, quad[3]),
  ];
}

/** Linear (translation-free) part of an affine map, for delta conversions. */
export function linearPart(matrix: Affine2D): Affine2D {
  return { a: matrix.a, b: matrix.b, c: matrix.c, d: matrix.d, e: 0, f: 0 };
}

/** Composes the five chain matrices into one local→browser-client CSS map. */
export function composeChain(matrices: Record<GeometryMatrixKey, Affine2D>): Affine2D {
  return GEOMETRY_MATRIX_KEYS.reduce<Affine2D>(
    (accumulated, key) => multiplyAffine(matrices[key], accumulated),
    IDENTITY_AFFINE,
  );
}

// ── Quad predicates ─────────────────────────────────────────────────────────

/** Twice the signed area of a quad (shoelace); sign encodes winding. */
export function signedAreaTwice(quad: Quad): number {
  let total = 0;
  for (let index = 0; index < 4; index += 1) {
    const current = quad[index];
    const next = quad[(index + 1) % 4];
    total += current.x * next.y - next.x * current.y;
  }
  return total;
}

export function quadArea(quad: Quad): number {
  return Math.abs(signedAreaTwice(quad)) / 2;
}

/** `+1`/`-1`/`0` winding of a quad as authored in semantic order. */
export function quadWindingSign(quad: Quad): -1 | 0 | 1 {
  const twice = signedAreaTwice(quad);
  if (twice > 0) return 1;
  if (twice < 0) return -1;
  return 0;
}

function cross(origin: GeometryPoint, a: GeometryPoint, b: GeometryPoint): number {
  return (a.x - origin.x) * (b.y - origin.y) - (a.y - origin.y) * (b.x - origin.x);
}

/** True when the quad is a non-degenerate, consistently-turning convex polygon. */
export function quadIsConvex(quad: Quad): boolean {
  if (!quad.every(isFinitePoint)) return false;
  const signs: number[] = [];
  for (let index = 0; index < 4; index += 1) {
    const turn = cross(quad[index], quad[(index + 1) % 4], quad[(index + 2) % 4]);
    if (turn === 0) return false;
    signs.push(turn > 0 ? 1 : -1);
  }
  return signs.every((sign) => sign === signs[0]);
}

function segmentsProperlyIntersect(
  a1: GeometryPoint,
  a2: GeometryPoint,
  b1: GeometryPoint,
  b2: GeometryPoint,
): boolean {
  const d1 = cross(a1, a2, b1);
  const d2 = cross(a1, a2, b2);
  const d3 = cross(b1, b2, a1);
  const d4 = cross(b1, b2, a2);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

/** True when opposite edges cross (a bow-tie); a convex quad is never simple-false. */
export function quadSelfIntersects(quad: Quad): boolean {
  return (
    segmentsProperlyIntersect(quad[0], quad[1], quad[2], quad[3]) ||
    segmentsProperlyIntersect(quad[1], quad[2], quad[3], quad[0])
  );
}

export function quadIsSimple(quad: Quad): boolean {
  return quadIsConvex(quad) && !quadSelfIntersects(quad);
}

/** Point-in-convex-quad in semantic order; winding sign is irrelevant. */
export function pointInConvexQuad(point: GeometryPoint, quad: Quad): boolean {
  if (!quadIsConvex(quad)) return false;
  const winding = quadWindingSign(quad);
  for (let index = 0; index < 4; index += 1) {
    const turn = cross(quad[index], quad[(index + 1) % 4], point);
    if (turn === 0) continue;
    if (turn > 0 ? winding < 0 : winding > 0) return false;
  }
  return true;
}

function distanceToSegment(point: GeometryPoint, a: GeometryPoint, b: GeometryPoint): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return Math.hypot(point.x - a.x, point.y - a.y);
  const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared));
  return Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy));
}

/** Minimum perpendicular distance from a point to any quad edge. */
export function distanceToQuadEdges(point: GeometryPoint, quad: Quad): number {
  let minimum = Number.POSITIVE_INFINITY;
  for (let index = 0; index < 4; index += 1) {
    minimum = Math.min(minimum, distanceToSegment(point, quad[index], quad[(index + 1) % 4]));
  }
  return minimum;
}

/** Bilinear interpolation in semantic corner order. */
export function bilinearPoint(quad: Quad, u: number, v: number): GeometryPoint {
  const [tl, tr, br, bl] = quad;
  const top = { x: tl.x + (tr.x - tl.x) * u, y: tl.y + (tr.y - tl.y) * u };
  const bottom = { x: bl.x + (br.x - bl.x) * u, y: bl.y + (br.y - bl.y) * u };
  return { x: top.x + (bottom.x - top.x) * v, y: top.y + (bottom.y - top.y) * v };
}

export function quadCentroid(quad: Quad): GeometryPoint {
  return {
    x: (quad[0].x + quad[1].x + quad[2].x + quad[3].x) / 4,
    y: (quad[0].y + quad[1].y + quad[2].y + quad[3].y) / 4,
  };
}

/** Deterministic hit-point candidate order (R8): center, then four inset quadrants. */
export const HIT_POINT_CANDIDATE_UVS = [
  { label: 'center', u: 0.5, v: 0.5 },
  { label: 'top-left', u: 0.25, v: 0.25 },
  { label: 'top-right', u: 0.75, v: 0.25 },
  { label: 'bottom-right', u: 0.75, v: 0.75 },
  { label: 'bottom-left', u: 0.25, v: 0.75 },
] as const;

/** Minimum perpendicular distance from every quad edge for a native drag origin. */
export const HIT_POINT_INSET_CSS_PX = 4;

export interface HitPointCandidate {
  label: string;
  point: GeometryPoint;
  edgeDistance: number;
}

/**
 * Deterministic eligible hit-point candidates inside a convex browser-client
 * quad: inside the quad and at least `4 CSS px` from every edge, in candidate
 * order. An ineligible candidate is skipped, never substituted.
 */
export function eligibleHitPointCandidates(
  quad: Quad,
  insetPx: number = HIT_POINT_INSET_CSS_PX,
): HitPointCandidate[] {
  if (!quadIsSimple(quad)) return [];
  const candidates: HitPointCandidate[] = [];
  for (const candidate of HIT_POINT_CANDIDATE_UVS) {
    const point = bilinearPoint(quad, candidate.u, candidate.v);
    if (!pointInConvexQuad(point, quad)) continue;
    const edgeDistance = distanceToQuadEdges(point, quad);
    if (edgeDistance < insetPx) continue;
    candidates.push({ label: candidate.label, point, edgeDistance });
  }
  return candidates;
}

// ── Canonical circle control envelope (R2, R5; padding-free, P1/P4) ─────────

export interface CircleControlBounds {
  left: number;
  right: number;
  top: number;
  bottom: number;
  x: number;
  y: number;
  width: number;
  height: number;
  centerX: number;
  centerY: number;
  radius: number;
  radiusY: number;
}

/**
 * Canonical circle control bounds from the authoritative payload alone. Radii
 * are clamped exactly as `transformGeometryToCircle` clamps them (a zero/negative
 * payload radius cannot silently produce a degenerate envelope). This depends
 * only on the raw payload and carries no frame padding.
 */
export function circleControlBounds(payload: CircleWarpPayloadInput): CircleControlBounds | null {
  const radius = normalizeFiniteNumber(Math.max(payload.radius, 1));
  const radiusY = normalizeFiniteNumber(
    payload.radiusY != null ? Math.max(payload.radiusY, 1) : Math.max(payload.radius, 1),
  );
  const centerX = normalizeFiniteNumber(payload.centerX);
  const centerY = normalizeFiniteNumber(payload.centerY);
  if (radius === null || radiusY === null || centerX === null || centerY === null) return null;
  const left = centerX - radius;
  const top = centerY - radiusY;
  return {
    left,
    right: centerX + radius,
    top,
    bottom: centerY + radiusY,
    x: left,
    y: top,
    width: radius * 2,
    height: radiusY * 2,
    centerX,
    centerY,
    radius,
    radiusY,
  };
}

/** The raw control box in the permanent semantic order, from the payload alone. */
export function canonicalWarpControlQuad(payload: CircleWarpPayloadInput): Quad | null {
  const bounds = circleControlBounds(payload);
  if (bounds === null) return null;
  return [
    { x: bounds.left, y: bounds.top },
    { x: bounds.right, y: bounds.top },
    { x: bounds.right, y: bounds.bottom },
    { x: bounds.left, y: bounds.bottom },
  ];
}

// ── Circle frame projection: reconstruction and exact validation (P3, P7) ───

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Reconstructs `warpControlToSubjectFrame` from published projection facts only
 * (P3, P4): translate the raw control-box origin by `(padLeft - bounds.x,
 * padTop - bounds.y)`, then flip about the published subject-frame center.
 *
 * This is the toolkit's *internal-coherence* check against the published matrix,
 * never a source for the canonical expected Layout-local transform.
 */
export function reconstructWarpControlToSubjectFrame(
  projection: CircleTextFrameProjectionV1,
): Affine2D | null {
  const padding = projection?.padding;
  const bounds = projection?.controlBounds;
  const subjectFrame = projection?.subjectFrame;
  const flips = projection?.flips;
  if (!padding || !bounds || !subjectFrame || !flips) return null;
  const tx = padding.left - bounds.x;
  const ty = padding.top - bounds.y;
  const signX = flips.x ? -1 : 1;
  const signY = flips.y ? -1 : 1;
  const flip: Affine2D = {
    a: signX,
    b: 0,
    c: 0,
    d: signY,
    e: signX === -1 ? 2 * subjectFrame.flipCenterX : 0,
    f: signY === -1 ? 2 * subjectFrame.flipCenterY : 0,
  };
  const matrix = multiplyAffine(flip, translationAffine(tx, ty));
  return isFiniteAffine(matrix) ? matrix : null;
}

export interface CircleFrameProjectionExpectations {
  /** Canonical control bounds derived from the accepted circle payload. */
  expectedControlBounds?: CircleControlBounds;
  /** Accepted semantic layer flips. */
  expectedFlips?: { flipX: boolean; flipY: boolean };
  /** Published `warpControlToSubjectFrame` to cross-check against the reconstruction. */
  publishedWarpControlToSubjectFrame?: Affine2D;
  /** Override for the reconstruction tolerance; defaults to `1e-6`. */
  matrixTolerance?: number;
}

/**
 * Exact validation of a renderer-published circle frame projection (P3).
 *
 * Fails `GEOMETRY_TRANSFORM_INVALID` for a missing/wrong-schema projection,
 * non-finite or negative padding, non-positive or wrong control/subject-frame
 * dimensions, flip-center or semantic-flip disagreement, and
 * published/reconstructed matrix disagreement. Fails
 * `GEOMETRY_REPRESENTATION_UNSUPPORTED` for an unrecognized future projection
 * kind and for asymmetric padding (P2, P7). A malformed projection may never
 * reach the Oracle.
 */
export function validateCircleTextFrameProjection(
  projection: unknown,
  expectations: CircleFrameProjectionExpectations = {},
): GeometryValidation {
  if (projection === null || typeof projection !== 'object') {
    return fail('GEOMETRY_TRANSFORM_INVALID', 'Geometry result carries no frame projection.', {
      reason: 'PROJECTION_MISSING',
    });
  }
  const candidate = projection as Partial<CircleTextFrameProjectionV1>;
  if (typeof candidate.kind !== 'string') {
    return fail('GEOMETRY_TRANSFORM_INVALID', 'Frame projection has no projection kind.', {
      reason: 'PROJECTION_KIND_MISSING',
    });
  }
  if (candidate.kind !== CIRCLE_TEXT_FRAME_PROJECTION_KIND) {
    return fail(
      'GEOMETRY_REPRESENTATION_UNSUPPORTED',
      `Frame projection kind ${candidate.kind} is not supported; ${CIRCLE_TEXT_FRAME_PROJECTION_KIND} is required.`,
      { reason: 'PROJECTION_KIND_UNSUPPORTED', kind: candidate.kind },
    );
  }

  const padding = candidate.padding;
  if (
    !padding ||
    !isFiniteNumber(padding.left) ||
    !isFiniteNumber(padding.right) ||
    !isFiniteNumber(padding.top) ||
    !isFiniteNumber(padding.bottom) ||
    padding.left < 0 ||
    padding.right < 0 ||
    padding.top < 0 ||
    padding.bottom < 0
  ) {
    return fail(
      'GEOMETRY_TRANSFORM_INVALID',
      'Frame projection padding is not four finite non-negative sides.',
      { reason: 'PADDING_INVALID' },
    );
  }
  if (
    padding.left !== padding.right ||
    padding.left !== padding.top ||
    padding.left !== padding.bottom
  ) {
    return fail(
      'GEOMETRY_REPRESENTATION_UNSUPPORTED',
      'Frame projection padding is asymmetric; the symmetric-cancellation profile does not apply.',
      { reason: 'PADDING_ASYMMETRIC' },
    );
  }

  const bounds = candidate.controlBounds;
  if (
    !bounds ||
    !isFiniteNumber(bounds.x) ||
    !isFiniteNumber(bounds.y) ||
    !isFiniteNumber(bounds.width) ||
    !isFiniteNumber(bounds.height) ||
    bounds.width <= 0 ||
    bounds.height <= 0
  ) {
    return fail(
      'GEOMETRY_TRANSFORM_INVALID',
      'Frame projection control bounds are not positive finite dimensions at a finite origin.',
      { reason: 'CONTROL_BOUNDS_INVALID' },
    );
  }

  const subjectFrame = candidate.subjectFrame;
  if (
    !subjectFrame ||
    !isFiniteNumber(subjectFrame.width) ||
    !isFiniteNumber(subjectFrame.height) ||
    !isFiniteNumber(subjectFrame.flipCenterX) ||
    !isFiniteNumber(subjectFrame.flipCenterY) ||
    subjectFrame.width <= 0 ||
    subjectFrame.height <= 0
  ) {
    return fail(
      'GEOMETRY_TRANSFORM_INVALID',
      'Frame projection subject-frame dimensions or flip centers are invalid.',
      { reason: 'SUBJECT_FRAME_INVALID' },
    );
  }
  if (
    Math.abs(subjectFrame.width - (bounds.width + padding.left + padding.right)) >
      GEOMETRY_CANONICAL_ARITHMETIC_EPSILON ||
    Math.abs(subjectFrame.height - (bounds.height + padding.top + padding.bottom)) >
      GEOMETRY_CANONICAL_ARITHMETIC_EPSILON
  ) {
    return fail(
      'GEOMETRY_TRANSFORM_INVALID',
      'Subject-frame dimensions do not equal control dimensions plus published padding.',
      { reason: 'SUBJECT_FRAME_DIMENSION_MISMATCH' },
    );
  }
  if (
    Math.abs(subjectFrame.flipCenterX - subjectFrame.width / 2) >
      GEOMETRY_CANONICAL_ARITHMETIC_EPSILON ||
    Math.abs(subjectFrame.flipCenterY - subjectFrame.height / 2) >
      GEOMETRY_CANONICAL_ARITHMETIC_EPSILON
  ) {
    return fail(
      'GEOMETRY_TRANSFORM_INVALID',
      'Subject-frame flip center is not half the subject-frame dimension.',
      { reason: 'FLIP_CENTER_MISMATCH' },
    );
  }

  const flips = candidate.flips;
  if (!flips || typeof flips.x !== 'boolean' || typeof flips.y !== 'boolean') {
    return fail('GEOMETRY_TRANSFORM_INVALID', 'Frame projection flips are not booleans.', {
      reason: 'FLIPS_INVALID',
    });
  }
  if (
    expectations.expectedFlips &&
    (flips.x !== expectations.expectedFlips.flipX || flips.y !== expectations.expectedFlips.flipY)
  ) {
    return fail(
      'GEOMETRY_TRANSFORM_INVALID',
      'Published projection flips disagree with the accepted semantic layer flips.',
      { reason: 'SEMANTIC_FLIP_MISMATCH' },
    );
  }

  if (expectations.expectedControlBounds) {
    const expected = expectations.expectedControlBounds;
    const agrees =
      Math.abs(bounds.x - expected.x) <= GEOMETRY_CANONICAL_ARITHMETIC_EPSILON &&
      Math.abs(bounds.y - expected.y) <= GEOMETRY_CANONICAL_ARITHMETIC_EPSILON &&
      Math.abs(bounds.width - expected.width) <= GEOMETRY_CANONICAL_ARITHMETIC_EPSILON &&
      Math.abs(bounds.height - expected.height) <= GEOMETRY_CANONICAL_ARITHMETIC_EPSILON;
    if (!agrees) {
      return fail(
        'GEOMETRY_TRANSFORM_INVALID',
        'Published control bounds disagree with the clamped canonical circle payload bounds.',
        { reason: 'CONTROL_BOUNDS_MISMATCH' },
      );
    }
  }

  if (expectations.publishedWarpControlToSubjectFrame) {
    const published = expectations.publishedWarpControlToSubjectFrame;
    if (!isFiniteAffine(published)) {
      return fail(
        'GEOMETRY_TRANSFORM_INVALID',
        'Published warpControlToSubjectFrame is not a finite affine map.',
        { reason: 'MATRIX_INVALID' },
      );
    }
    const reconstructed = reconstructWarpControlToSubjectFrame(
      candidate as CircleTextFrameProjectionV1,
    );
    const tolerance = expectations.matrixTolerance ?? GEOMETRY_MATRIX_RECONSTRUCTION_TOLERANCE;
    if (reconstructed === null || !affineAgreesWithin(reconstructed, published, tolerance)) {
      return fail(
        'GEOMETRY_TRANSFORM_INVALID',
        'Published warpControlToSubjectFrame disagrees with the matrix reconstructed from projection facts.',
        { reason: 'MATRIX_RECONSTRUCTION_MISMATCH' },
      );
    }
  }

  return { ok: true };
}

// ── Canonical padding-free Layout-local transform (P1, P4) ──────────────────

export interface CanonicalCircleControlToLayoutInput {
  payload: CircleWarpPayloadInput;
  /** Layer position in Layout-local units, from the accepted snapshot. */
  xCoordinate: number;
  yCoordinate: number;
  /** Layer rotation in degrees, matching the product `ArtworkTextLayer.rotation`. */
  rotationDegrees: number;
  flipX: boolean;
  flipY: boolean;
}

/**
 * The padding-free canonical `controlToLayout` matrix (P1, P4):
 *
 * ```text
 * Translate(xCoordinate + radius, yCoordinate + radiusY)
 *   × Rotate(layer.rotation)
 *   × Scale(flipX ? -1 : 1, flipY ? -1 : 1)
 *   × Translate(-centerX, -centerY)
 * ```
 *
 * Symmetric circle frame padding cancels out of the full renderer composition,
 * so this matrix is exact without any product padding constant, shadow formula,
 * or caller-provided padding scalar. It places the unrotated, unflipped
 * top-left control corner exactly at `(xCoordinate, yCoordinate)`, then applies
 * flips and rotation about the control-envelope center.
 */
export function canonicalCircleControlToLayoutMatrix(
  input: CanonicalCircleControlToLayoutInput,
): Affine2D | null {
  const bounds = circleControlBounds(input.payload);
  const xCoordinate = normalizeFiniteNumber(input.xCoordinate);
  const yCoordinate = normalizeFiniteNumber(input.yCoordinate);
  const rotationDegrees = normalizeFiniteNumber(input.rotationDegrees);
  if (bounds === null || xCoordinate === null || yCoordinate === null || rotationDegrees === null) {
    return null;
  }
  const toControlOrigin = translationAffine(-bounds.centerX, -bounds.centerY);
  const flip = scaleAffine(input.flipX ? -1 : 1, input.flipY ? -1 : 1);
  const rotate = rotationAffine((rotationDegrees * Math.PI) / 180);
  const place = translationAffine(xCoordinate + bounds.radius, yCoordinate + bounds.radiusY);
  return multiplyAffine(place, multiplyAffine(rotate, multiplyAffine(flip, toControlOrigin)));
}

/**
 * The canonical circle control envelope in Layout-local space: the raw ordered
 * control box placed by the padding-free cancellation transform. This is the
 * toolkit's independent expectation, computed from accepted snapshot state
 * alone — never from bridge padding or a bridge matrix (P1, P4).
 */
export function canonicalCircleControlEnvelopeLayoutQuad(
  input: CanonicalCircleControlToLayoutInput,
): Quad | null {
  const raw = canonicalWarpControlQuad(input.payload);
  const matrix = canonicalCircleControlToLayoutMatrix(input);
  if (raw === null || matrix === null) return null;
  return transformQuad(matrix, raw);
}

/**
 * `subjectFrameToLayout`: rotate the padded subject frame about its center and
 * place its origin at `(frameX, frameY)`. Retained as generic pivot/affine math
 * for modelling the renderer chain in algebra tests; it takes the frame origin
 * and dimensions as inputs and embeds no product padding authority.
 */
export function subjectFrameToLayoutMatrix(input: {
  frameX: number;
  frameY: number;
  frameWidth: number;
  frameHeight: number;
  rotationDegrees: number;
}): Affine2D {
  const rotation = rotationAffine((input.rotationDegrees * Math.PI) / 180);
  const pivot = { x: input.frameWidth / 2, y: input.frameHeight / 2 };
  const anchor = { x: input.frameX + pivot.x, y: input.frameY + pivot.y };
  const rotatedPivot = applyAffine(rotation, pivot);
  return multiplyAffine(
    translationAffine(anchor.x - rotatedPivot.x, anchor.y - rotatedPivot.y),
    rotation,
  );
}

// ── Fingerprints (R7, P5) ───────────────────────────────────────────────────

/** FNV-1a 64-bit in four 16-bit little-endian limbs (ES2017: no BigInt). */
const FNV1A64_OFFSET = [0x2325, 0x8422, 0x9ce4, 0xcbf2] as const;
const FNV1A64_PRIME = [0x01b3, 0x0000, 0x0100, 0x0000] as const;

export function fnv1a64Hex(input: string): string {
  const limbs: number[] = [...FNV1A64_OFFSET];
  for (let index = 0; index < input.length; index += 1) {
    limbs[0] = (limbs[0] ^ (input.charCodeAt(index) & 0xffff)) >>> 0;
    const products = [
      limbs[0] * FNV1A64_PRIME[0],
      limbs[1] * FNV1A64_PRIME[0],
      limbs[2] * FNV1A64_PRIME[0] + limbs[0] * FNV1A64_PRIME[2],
      limbs[3] * FNV1A64_PRIME[0] + limbs[1] * FNV1A64_PRIME[2],
    ];
    let carry = 0;
    for (let limb = 0; limb < 4; limb += 1) {
      const value = products[limb] + carry;
      limbs[limb] = value % 0x10000;
      carry = Math.floor(value / 0x10000);
    }
  }
  return [3, 2, 1, 0].map((limb) => limbs[limb].toString(16).padStart(4, '0')).join('');
}

function canonicalScalar(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    const normalized = normalizeFiniteNumber(value);
    if (normalized === null) throw new Error('Fingerprint preimage contains a non-finite number.');
    return JSON.stringify(normalized);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalScalar).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalScalar(record[key])}`).join(',')}}`;
  }
  throw new Error('Fingerprint preimage contains an unsupported value.');
}

/**
 * The versioned canonical warp-fingerprint preimage: every circle payload field
 * in fixed order, so object-key order or array order cannot change the digest.
 */
export function buildWarpFingerprintPreimage(payload: CircleWarpPayloadInput): string {
  return canonicalScalar({
    version: WARP_FINGERPRINT_PREIMAGE_VERSION,
    warpType: 'circle',
    values: [
      payload.centerX,
      payload.centerY,
      payload.radius,
      payload.radiusY ?? null,
      payload.rotationAngle,
      payload.arcLength,
      payload.inverted,
      payload.verticalAlign,
      payload.arcAlign,
    ],
  });
}

export function computeCircleWarpFingerprint(payload: CircleWarpPayloadInput): string {
  return fnv1a64Hex(buildWarpFingerprintPreimage(payload));
}

function quadPreimage(quad: Quad): number[] {
  return [quad[0].x, quad[0].y, quad[1].x, quad[1].y, quad[2].x, quad[2].y, quad[3].x, quad[3].y];
}

function affinePreimage(matrix: Affine2D): number[] {
  return [matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f];
}

function projectionPreimage(projection: CircleTextFrameProjectionV1): Record<string, unknown> {
  return {
    kind: projection.kind,
    padding: [
      projection.padding.left,
      projection.padding.right,
      projection.padding.top,
      projection.padding.bottom,
    ],
    controlBounds: [
      projection.controlBounds.x,
      projection.controlBounds.y,
      projection.controlBounds.width,
      projection.controlBounds.height,
    ],
    subjectFrame: [
      projection.subjectFrame.width,
      projection.subjectFrame.height,
      projection.subjectFrame.flipCenterX,
      projection.subjectFrame.flipCenterY,
    ],
    flips: [projection.flips.x, projection.flips.y],
  };
}

export interface RepresentationFingerprintInput {
  representation: Omit<
    CircleControlEnvelopeQuadV1,
    'representationFingerprint' | 'warpFingerprint'
  >;
  targetId: string;
  layoutId: string;
  cssRatios: { x: number; y: number };
  bridgeGeneration: number;
  warpFingerprint: string;
}

/**
 * The versioned canonical representation-fingerprint preimage: representation
 * and projection kinds, the full projection fields, all six point arrays, all
 * five matrices, target/Layout identities, measured CSS ratios, and bridge
 * generation — in fixed order (R7, P5). Every projection field therefore
 * participates in equality/currentness and torn-observation detection.
 */
export function buildRepresentationFingerprintPreimage(
  input: RepresentationFingerprintInput,
): string {
  const { representation } = input;
  return canonicalScalar({
    version: REPRESENTATION_FINGERPRINT_PREIMAGE_VERSION,
    kind: representation.kind,
    pointOrder: [...representation.pointOrder],
    warpType: representation.warpType,
    units: representation.units,
    projection: projectionPreimage(representation.projection),
    spaces: {
      warpControlLocal: quadPreimage(representation.warpControlLocal),
      subjectFrameLocal: quadPreimage(representation.subjectFrameLocal),
      layoutLocal: quadPreimage(representation.layoutLocal),
      worldScene: quadPreimage(representation.worldScene),
      stageViewportCss: quadPreimage(representation.stageViewportCss),
      browserClientCss: quadPreimage(representation.browserClientCss),
    },
    matrices: GEOMETRY_MATRIX_KEYS.map((key) => [
      key,
      affinePreimage(representation.matrices[key]),
    ]),
    targetId: input.targetId,
    layoutId: input.layoutId,
    cssRatios: [input.cssRatios.x, input.cssRatios.y],
    bridgeGeneration: input.bridgeGeneration,
    warpFingerprint: input.warpFingerprint,
  });
}

export function computeRepresentationFingerprint(input: RepresentationFingerprintInput): string {
  return fnv1a64Hex(buildRepresentationFingerprintPreimage(input));
}

// ── Validation ──────────────────────────────────────────────────────────────

function fail(
  code: GeometryContractFailure['code'],
  detail: string,
  context: Record<string, string> = {},
): { ok: false; failure: GeometryContractFailure } {
  const reason = context.reason ?? code;
  return { ok: false, failure: { code, detail, reason, context } };
}

export interface ValidateEnvelopeInput {
  schemaVersion: unknown;
  representation: unknown;
  provenance: unknown;
  ratios: unknown;
  /**
   * Optional canonical expectations. When the caller has the accepted circle
   * payload/flips (Phase B Oracle/adapter), the projection is validated exactly
   * against them, including control bounds and semantic flips (P3).
   */
  expectedControlBounds?: CircleControlBounds;
  expectedFlips?: { flipX: boolean; flipY: boolean };
}

/**
 * Validates the typed geometry record against schema v2. Any wrong warp,
 * unsupported representation, malformed projection, non-finite point/matrix,
 * invalid ratio, or missing provenance identity fails closed with a precise
 * code and reason (R14, P7).
 */
export function validateTypedGeometry(input: ValidateEnvelopeInput): GeometryValidation {
  if (input.schemaVersion !== GEOMETRY_SCHEMA_VERSION) {
    return fail(
      'GEOMETRY_REPRESENTATION_UNSUPPORTED',
      `Geometry schema ${String(input.schemaVersion)} is not supported; schema ${GEOMETRY_SCHEMA_VERSION} is required.`,
      { reason: 'SCHEMA_VERSION_UNSUPPORTED', schemaVersion: String(input.schemaVersion) },
    );
  }
  const representation = input.representation as Partial<CircleControlEnvelopeQuadV1> | null;
  if (representation === null || typeof representation !== 'object') {
    return fail('GEOMETRY_REPRESENTATION_UNSUPPORTED', 'geometry() returned no representation.', {
      reason: 'REPRESENTATION_MISSING',
    });
  }
  if (representation.kind !== CIRCLE_CONTROL_ENVELOPE_KIND) {
    return fail(
      'GEOMETRY_REPRESENTATION_UNSUPPORTED',
      `Representation kind ${String(representation.kind)} is not ${CIRCLE_CONTROL_ENVELOPE_KIND}.`,
      { reason: 'REPRESENTATION_KIND_UNSUPPORTED', kind: String(representation.kind) },
    );
  }
  if (representation.warpType !== 'circle') {
    return fail(
      'GEOMETRY_REPRESENTATION_UNSUPPORTED',
      `Representation warpType ${String(representation.warpType)} is not circle.`,
      { reason: 'WARP_TYPE_UNSUPPORTED', warpType: String(representation.warpType) },
    );
  }
  const expectedOrder = CIRCLE_CONTROL_ENVELOPE_POINT_ORDER.join(',');
  const observedOrder = Array.isArray(representation.pointOrder)
    ? representation.pointOrder.join(',')
    : String(representation.pointOrder);
  if (observedOrder !== expectedOrder) {
    return fail(
      'GEOMETRY_REPRESENTATION_UNSUPPORTED',
      `Representation point order ${observedOrder} is not ${expectedOrder}.`,
      { reason: 'POINT_ORDER_UNSUPPORTED', pointOrder: observedOrder },
    );
  }
  for (const [key, unit] of Object.entries(GEOMETRY_SPACE_UNITS)) {
    if ((representation.units as Record<string, unknown> | undefined)?.[key] !== unit) {
      return fail(
        'GEOMETRY_REPRESENTATION_UNSUPPORTED',
        `Representation unit for ${key} is not ${unit}.`,
        { reason: 'SPACE_UNIT_UNSUPPORTED', space: key },
      );
    }
  }
  for (const space of GEOMETRY_SPACES) {
    const quad = representation[space] as Quad | undefined;
    if (!Array.isArray(quad) || quad.length !== 4 || !quad.every(isFinitePoint)) {
      return fail(
        'GEOMETRY_TRANSFORM_INVALID',
        `Representation ${space} is not four finite points.`,
        { reason: 'QUAD_INVALID', space },
      );
    }
  }
  const matrices = representation.matrices as Record<GeometryMatrixKey, Affine2D> | undefined;
  for (const key of GEOMETRY_MATRIX_KEYS) {
    const matrix = matrices?.[key];
    if (!matrix || !isFiniteAffine(matrix)) {
      return fail('GEOMETRY_TRANSFORM_INVALID', `Matrix ${key} is not a finite affine map.`, {
        reason: 'MATRIX_INVALID',
        matrix: key,
      });
    }
  }
  const ratios = input.ratios as { x?: unknown; y?: unknown } | null;
  if (
    ratios === null ||
    typeof ratios !== 'object' ||
    typeof ratios.x !== 'number' ||
    typeof ratios.y !== 'number' ||
    !Number.isFinite(ratios.x) ||
    !Number.isFinite(ratios.y) ||
    ratios.x <= 0 ||
    ratios.y <= 0
  ) {
    return fail(
      'GEOMETRY_TRANSFORM_INVALID',
      'Measured canvas-to-CSS ratios are not finite and positive.',
      { reason: 'CSS_RATIO_INVALID' },
    );
  }
  const provenance = input.provenance as Partial<TypedRendererProvenanceV2> | null;
  if (
    provenance === null ||
    typeof provenance !== 'object' ||
    provenance.schemaVersion !== 2 ||
    typeof provenance.target?.id !== 'string' ||
    typeof provenance.layout?.id !== 'string'
  ) {
    return fail(
      'GEOMETRY_TRANSFORM_INVALID',
      'Typed renderer provenance is missing the live target/Layout identity.',
      { reason: 'PROVENANCE_IDENTITY_MISSING' },
    );
  }
  const provenanceMatrices = [
    provenance.target?.subjectFrameToLayout,
    provenance.layout?.layoutToWorldScene,
  ];
  if (provenanceMatrices.some((matrix) => !matrix || !isFiniteAffine(matrix))) {
    return fail(
      'GEOMETRY_TRANSFORM_INVALID',
      'Typed renderer provenance carries a non-finite target/Layout affine map.',
      { reason: 'PROVENANCE_MATRIX_INVALID' },
    );
  }
  if (
    typeof provenance.stageFingerprint !== 'string' ||
    typeof provenance.target?.fingerprint !== 'string' ||
    typeof provenance.layout?.fingerprint !== 'string' ||
    typeof provenance.representationFingerprint !== 'string'
  ) {
    return fail(
      'GEOMETRY_TRANSFORM_INVALID',
      'Typed renderer provenance is missing a fingerprint.',
      { reason: 'PROVENANCE_FINGERPRINT_MISSING' },
    );
  }

  return validateCircleTextFrameProjection(representation.projection, {
    expectedControlBounds: input.expectedControlBounds,
    expectedFlips: input.expectedFlips,
    publishedWarpControlToSubjectFrame: matrices?.warpControlToSubjectFrame,
  });
}
