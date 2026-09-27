import {
  createDiagnostic,
  type DiagnosticCode,
  type DiagnosticRecord,
} from '../contracts/diagnostics';
/**
 * Private/deprecated legacy composite check mirror (ADR 0032 §E3-S1). It is
 * retained only so this Oracle module compiles until the E3-S2 architecture
 * switch consumes the additive `primitiveFacts` below. It is deliberately
 * declared locally (never imported from `contracts/execution`) so the Oracle no
 * longer reaches the legacy boolean result authority, and it is never the source
 * of a final status.
 *
 * @deprecated E3-S2 removes the legacy composite authority entirely.
 */
interface LegacyCompositeCheck {
  readonly checkId: string;
  readonly passed: boolean;
}
import {
  applyAffine,
  canonicalCircleControlEnvelopeLayoutQuad,
  circleControlBounds,
  computeCircleWarpFingerprint,
  computeRepresentationFingerprint,
  determinantParity,
  isFinitePoint,
  linearPart,
  multiplyAffine,
  quadArea,
  quadIsSimple,
  quadWindingSign,
  transformQuad,
  validateTypedGeometry,
  type Affine2D,
  type CanonicalCircleControlToLayoutInput,
  type CircleControlEnvelopeQuadV1,
  type CircleWarpPayloadInput,
  type GeometryPoint,
  type Quad,
  type TypedGeometryResult,
  type TypedRendererProvenanceV2,
} from '../contracts/geometry-v2';
import {
  CANONICAL_EXACT_TOLERANCE,
  RENDER_TRANSFORM_CSS_TOLERANCE,
  type MinimumDelta,
} from './geometry';

/**
 * `warped-text-circle-move-v1` Oracle profile (WP5 Slice 5-B; R13, P10).
 *
 * Two independent authorities are compared and neither may rescue the other:
 *
 *  - the *canonical* authority recomputes the circle control envelope's
 *    Layout-local placement from the accepted snapshot's authoritative
 *    `layoutItems` alone, using the padding-free cancellation transform. It never
 *    reads bridge padding, a bridge matrix, or a parsed fingerprint;
 *  - the *renderer* authority is the bridge's typed geometry v2 record.
 *
 * Required checks:
 *
 *  - `geometry.delta` — the canonical Layout-local translation must meet the
 *    required minimum, and every one of the four corresponding browser-client
 *    points must move by exactly that translation transformed by the unchanged
 *    Layout-to-browser linear matrix, within `0.25 CSS px` per point and axis;
 *  - `geometry.warp-envelope` — both baseline and observed evidence must prove
 *    the circle representation kind/order/spaces/units/projection, the
 *    independently recomputed raw and canonical quads, identity and provenance
 *    agreement, non-degeneracy, winding, unchanged warp fingerprint, unchanged
 *    edge vectors, and no AABB/screenshot/parsed-fingerprint participation.
 */

export const WARPED_TEXT_ORACLE_PROFILE_ID = 'warped-text-circle-move-v1';

export interface WarpedCanonicalLayer {
  parentLayoutId: string;
  xCoordinate: number;
  yCoordinate: number;
  rotation: number;
  flipX: boolean;
  flipY: boolean;
  payload: CircleWarpPayloadInput;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Reads the authoritative circle-warped Text layer for a target id from accepted
 * `layoutItems`, including its parent Layout id. Returns `null` when the layer is
 * missing, not a Text layer, or not a circle warp.
 */
export function findWarpedCanonicalLayer(
  layoutItems: unknown,
  elementId: string,
): WarpedCanonicalLayer | null {
  if (!Array.isArray(layoutItems)) return null;
  for (const layout of layoutItems) {
    if (!isRecord(layout)) continue;
    const parentLayoutId = typeof layout.id === 'string' ? layout.id : null;
    const layers = layout.layers;
    if (parentLayoutId === null || !Array.isArray(layers)) continue;
    for (const layer of layers) {
      if (!isRecord(layer) || layer.id !== elementId) continue;
      if (layer.type !== 'TEXT') return null;
      const warp = layer.warp;
      if (!isRecord(warp) || warp.type !== 'circle' || !isRecord(warp.payload)) return null;
      const payload = warp.payload;
      const numeric = (value: unknown): number | null =>
        typeof value === 'number' && Number.isFinite(value) ? value : null;
      const centerX = numeric(payload.centerX);
      const centerY = numeric(payload.centerY);
      const radius = numeric(payload.radius);
      const radiusY = numeric(payload.radiusY);
      const rotationAngle = numeric(payload.rotationAngle);
      const arcLength = numeric(payload.arcLength);
      const xCoordinate = numeric(layer.xCoordinate);
      const yCoordinate = numeric(layer.yCoordinate);
      if (
        centerX === null ||
        centerY === null ||
        radius === null ||
        radiusY === null ||
        rotationAngle === null ||
        arcLength === null ||
        xCoordinate === null ||
        yCoordinate === null
      ) {
        return null;
      }
      const transform = isRecord(layer.transform) ? layer.transform : {};
      const rotation = numeric(layer.rotation) ?? 0;
      return {
        parentLayoutId,
        xCoordinate,
        yCoordinate,
        rotation,
        flipX: transform.flipX === true,
        flipY: transform.flipY === true,
        payload: {
          centerX,
          centerY,
          radius,
          radiusY,
          rotationAngle,
          arcLength,
          inverted: payload.inverted === true,
          verticalAlign:
            typeof payload.verticalAlign === 'string' ? payload.verticalAlign : 'center',
          arcAlign: typeof payload.arcAlign === 'string' ? payload.arcAlign : 'center',
        },
      };
    }
  }
  return null;
}

function canonicalInputFromLayer(layer: WarpedCanonicalLayer): CanonicalCircleControlToLayoutInput {
  return {
    payload: layer.payload,
    xCoordinate: layer.xCoordinate,
    yCoordinate: layer.yCoordinate,
    rotationDegrees: layer.rotation,
    flipX: layer.flipX,
    flipY: layer.flipY,
  };
}

export interface WarpedGeometrySource {
  layoutItems: unknown;
  geometryV2: (TypedGeometryResult & { envelopeFingerprint?: string }) | null;
}

export interface WarpedTextOracleInput {
  minimumDelta: MinimumDelta;
  targetId: string;
  /** The expected parent Layout id, from the accepted seal. */
  expectedLayoutId: string;
  baseline: WarpedGeometrySource;
  observed: WarpedGeometrySource;
}

export interface WarpedDeltaEvidence {
  canonicalDelta: GeometryPoint | null;
  canonicalMet: boolean;
  expectedRendererDelta: GeometryPoint | null;
  maxPointAxisDeviation: number | null;
  rendererDeltaPerPoint: readonly GeometryPoint[] | null;
}

export interface WarpedEnvelopeEvidence {
  baselineFingerprint: string | null;
  observedFingerprint: string | null;
  maxCanonicalDeviation: number | null;
  maxRenderedDeviation: number | null;
}

/**
 * Closed explicit authority vocabulary for the additive primitive observations
 * (ADR 0029 §4 B2-B). `current` means the accepted sources were readable and
 * the measured observations are trustworthy; `malformed` means the Oracle could
 * not read them at all. This is the only authority a B2-B adapter may read; the
 * legacy aggregate harness-validity flag is deliberately not part of this view.
 */
export const WARPED_PRIMITIVE_AUTHORITIES = ['current', 'malformed'] as const;
export type WarpedPrimitiveAuthority = (typeof WARPED_PRIMITIVE_AUTHORITIES)[number];

/** The two delivered required-check ids the warped Oracle evaluates. */
export type WarpedRequiredCheckId = 'geometry.delta' | 'geometry.warp-envelope';

/**
 * Raw measured numeric/envelope observations backing one warped evaluation.
 * Every field is a primitive measurement (or `null` when unreadable), never a
 * translated boolean check result.
 */
export interface WarpedPrimitiveMeasurements {
  readonly canonicalDelta: GeometryPoint | null;
  readonly minimumDelta: { readonly x: number; readonly y: number } | null;
  readonly maxPointAxisDeviation: number | null;
  readonly maxCanonicalDeviation: number | null;
  readonly maxRenderedDeviation: number | null;
  readonly envelopeFailures: readonly string[];
}

/** The explicit tolerances applied to the measured observations. */
export interface WarpedPrimitiveTolerances {
  readonly canonical: number;
  readonly renderer: number;
}

/** One explicit per-check predicate derived from the measurements/tolerances. */
export interface WarpedPrimitiveCheckFact {
  readonly checkId: WarpedRequiredCheckId;
  readonly predicateMet: boolean;
}

/**
 * Additive, explicitly named primitive warped-evaluation facts (ADR 0029 §4
 * B2-B). They are derived from the Oracle's own raw numeric/envelope
 * observations and expose: an explicit structured authority, the independent
 * canonical/renderer source-agreement primitives, the raw measured values and
 * the applied tolerances, and one explicit predicate per required check. No
 * field here is a legacy composite boolean check result.
 */
export interface WarpedPrimitiveFacts {
  readonly authority: WarpedPrimitiveAuthority;
  readonly canonicalSourcesAgree: boolean;
  readonly rendererSourcesAgree: boolean;
  readonly measured: WarpedPrimitiveMeasurements;
  readonly tolerances: WarpedPrimitiveTolerances;
  readonly checks: readonly WarpedPrimitiveCheckFact[];
}

export interface WarpedOracleEvaluation {
  profileId: typeof WARPED_TEXT_ORACLE_PROFILE_ID;
  checks: readonly LegacyCompositeCheck[];
  requiredSourcesAgree: boolean;
  harnessInvalid: boolean;
  diagnostics: readonly DiagnosticRecord[];
  delta: WarpedDeltaEvidence;
  envelope: WarpedEnvelopeEvidence;
  /**
   * Additive primitive facts for the inactive B2-B live-fact adapter. The
   * legacy `checks`/`requiredSourcesAgree`/`harnessInvalid` fields above remain
   * for the active runtime until the B2-E cutover; the adapter reads only this
   * view.
   */
  primitiveFacts: WarpedPrimitiveFacts;
}

function primitiveTolerances(): WarpedPrimitiveTolerances {
  return { canonical: CANONICAL_EXACT_TOLERANCE, renderer: RENDER_TRANSFORM_CSS_TOLERANCE };
}

function emptyMeasurements(): WarpedPrimitiveMeasurements {
  return {
    canonicalDelta: null,
    minimumDelta: null,
    maxPointAxisDeviation: null,
    maxCanonicalDeviation: null,
    maxRenderedDeviation: null,
    envelopeFailures: [],
  };
}

/**
 * The explicit primitive facts of a malformed evaluation: no readable sources,
 * so the authority is `malformed`, both source-agreement primitives are false,
 * every measurement is absent, and no check predicate is met.
 */
function malformedPrimitiveFacts(): WarpedPrimitiveFacts {
  return {
    authority: 'malformed',
    canonicalSourcesAgree: false,
    rendererSourcesAgree: false,
    measured: emptyMeasurements(),
    tolerances: primitiveTolerances(),
    checks: [
      { checkId: 'geometry.delta', predicateMet: false },
      { checkId: 'geometry.warp-envelope', predicateMet: false },
    ],
  };
}

function emptyDelta(): WarpedDeltaEvidence {
  return {
    canonicalDelta: null,
    canonicalMet: false,
    expectedRendererDelta: null,
    maxPointAxisDeviation: null,
    rendererDeltaPerPoint: null,
  };
}

function emptyEnvelope(): WarpedEnvelopeEvidence {
  return {
    baselineFingerprint: null,
    observedFingerprint: null,
    maxCanonicalDeviation: null,
    maxRenderedDeviation: null,
  };
}

function unusable(
  code: DiagnosticCode,
  detail: string,
  context: Record<string, string> = {},
  evidence: {
    delta?: WarpedDeltaEvidence;
    envelope?: WarpedEnvelopeEvidence;
  } = {},
): WarpedOracleEvaluation {
  return {
    profileId: WARPED_TEXT_ORACLE_PROFILE_ID,
    checks: [
      { checkId: 'geometry.delta', passed: false },
      { checkId: 'geometry.warp-envelope', passed: false },
    ],
    requiredSourcesAgree: false,
    harnessInvalid: true,
    diagnostics: [
      createDiagnostic(code, detail, {
        context: { profileId: WARPED_TEXT_ORACLE_PROFILE_ID, ...context },
      }),
    ],
    delta: evidence.delta ?? emptyDelta(),
    envelope: evidence.envelope ?? emptyEnvelope(),
    primitiveFacts: malformedPrimitiveFacts(),
  };
}

interface EnvelopeFacts {
  record: CircleControlEnvelopeQuadV1;
  provenance: TypedRendererProvenanceV2;
  cssRatios: { x: number; y: number };
}

function readEnvelopeFacts(source: WarpedGeometrySource): EnvelopeFacts | null {
  const typed = source.geometryV2;
  if (typed === null) return null;
  const representation = typed.representation as CircleControlEnvelopeQuadV1 | undefined;
  const provenance = typed.typedProvenance as TypedRendererProvenanceV2 | undefined;
  const cssRatios = typed.cssRatios as { x: number; y: number } | undefined;
  if (!representation || !provenance || !cssRatios) return null;
  return { record: representation, provenance, cssRatios };
}

function maxPointAxisDifference(left: Quad, right: Quad): number {
  let maximum = 0;
  for (let index = 0; index < 4; index += 1) {
    maximum = Math.max(maximum, Math.abs(left[index].x - right[index].x));
    maximum = Math.max(maximum, Math.abs(left[index].y - right[index].y));
  }
  return maximum;
}

function quadHasOnlyFinitePoints(quad: Quad): boolean {
  return quad.every((point) => isFinitePoint(point));
}

/** The Layout-local -> browser-client chain, composed from the record matrices. */
function layoutToBrowserMatrix(record: CircleControlEnvelopeQuadV1): Affine2D {
  return multiplyAffine(
    record.matrices.stageViewportToBrowserClientCss,
    multiplyAffine(
      record.matrices.worldSceneToStageViewportCss,
      record.matrices.layoutToWorldScene,
    ),
  );
}

/** Edge vectors from the first corner, used to prove a rigid translation. */
function edgeVectors(quad: Quad): readonly GeometryPoint[] {
  return [0, 1, 2, 3].map((index) => ({
    x: quad[index].x - quad[0].x,
    y: quad[index].y - quad[0].y,
  }));
}

function maxEdgeDifference(left: Quad, right: Quad): number {
  const leftEdges = edgeVectors(left);
  const rightEdges = edgeVectors(right);
  let maximum = 0;
  for (let index = 0; index < 4; index += 1) {
    maximum = Math.max(maximum, Math.abs(leftEdges[index].x - rightEdges[index].x));
    maximum = Math.max(maximum, Math.abs(leftEdges[index].y - rightEdges[index].y));
  }
  return maximum;
}

/**
 * The profile's single accepted evaluation. It returns PASS/FAIL checks and a
 * separate `harnessInvalid` flag: malformed authority is `HARNESS_BLOCKED`; a
 * coherent canonical/renderer disagreement is a product `BUG`.
 */
export function evaluateWarpedTextOracle(input: WarpedTextOracleInput): WarpedOracleEvaluation {
  const canonicalBefore = findWarpedCanonicalLayer(input.baseline.layoutItems, input.targetId);
  const canonicalAfter = findWarpedCanonicalLayer(input.observed.layoutItems, input.targetId);
  if (canonicalBefore === null || canonicalAfter === null) {
    return unusable(
      'GEOMETRY_REPRESENTATION_UNSUPPORTED',
      'The accepted snapshot does not resolve exactly one circle-warped Text layer for the target.',
      { targetId: input.targetId },
    );
  }
  if (
    canonicalBefore.parentLayoutId !== input.expectedLayoutId ||
    canonicalAfter.parentLayoutId !== input.expectedLayoutId
  ) {
    return unusable(
      'GEOMETRY_LAYOUT_ID_MISMATCH',
      'The resolved target is not a child of the accepted parent Layout.',
      {
        targetId: input.targetId,
        expectedLayoutId: input.expectedLayoutId,
        baselineParentId: canonicalBefore.parentLayoutId,
        observedParentId: canonicalAfter.parentLayoutId,
      },
    );
  }

  const before = readEnvelopeFacts(input.baseline);
  const after = readEnvelopeFacts(input.observed);
  if (before === null || after === null) {
    return unusable(
      'GEOMETRY_TRANSFORM_INVALID',
      'The bridge published no typed geometry schema v2 record for the warped target.',
      { targetId: input.targetId },
    );
  }

  const diagnostics: DiagnosticRecord[] = [];
  const envelopeFailures: string[] = [];

  // ── Schema, projection, and provenance validation (malformed -> harness) ──
  const validateSide = (
    label: 'baseline' | 'observed',
    facts: EnvelopeFacts,
    canonical: WarpedCanonicalLayer,
  ): string | null => {
    const bounds = circleControlBounds(canonical.payload);
    if (bounds === null) return `${label}: canonical circle control bounds are unavailable.`;
    const validation = validateTypedGeometry({
      schemaVersion: 2,
      representation: facts.record,
      provenance: facts.provenance,
      ratios: facts.cssRatios,
      expectedControlBounds: bounds,
      expectedFlips: { flipX: canonical.flipX, flipY: canonical.flipY },
    });
    if (!validation.ok) {
      return `${label}: ${validation.failure.code}/${validation.failure.reason}: ${validation.failure.detail}`;
    }
    if (facts.provenance.schemaVersion !== 2) {
      return `${label}: typed renderer provenance schema is not 2.`;
    }
    if (facts.provenance.target.id !== input.targetId) {
      return `${label}: GEOMETRY_TARGET_ID_MISMATCH: provenance target id ${facts.provenance.target.id} is not ${input.targetId}.`;
    }
    if (facts.provenance.layout.id !== input.expectedLayoutId) {
      return `${label}: GEOMETRY_LAYOUT_ID_MISMATCH: provenance Layout id ${facts.provenance.layout.id} is not ${input.expectedLayoutId}.`;
    }
    const expectedWarpFingerprint = computeCircleWarpFingerprint(canonical.payload);
    if (facts.record.warpFingerprint !== expectedWarpFingerprint) {
      return `${label}: WARP_FINGERPRINT_MISMATCH: published warp fingerprint disagrees with the authoritative payload.`;
    }
    const recomputedRepresentation = computeRepresentationFingerprint({
      representation: {
        kind: facts.record.kind,
        pointOrder: facts.record.pointOrder,
        warpType: facts.record.warpType,
        units: facts.record.units,
        projection: facts.record.projection,
        warpControlLocal: facts.record.warpControlLocal,
        subjectFrameLocal: facts.record.subjectFrameLocal,
        layoutLocal: facts.record.layoutLocal,
        worldScene: facts.record.worldScene,
        stageViewportCss: facts.record.stageViewportCss,
        browserClientCss: facts.record.browserClientCss,
        matrices: facts.record.matrices,
      },
      targetId: input.targetId,
      layoutId: input.expectedLayoutId,
      cssRatios: facts.cssRatios,
      bridgeGeneration: facts.provenance.bridgeGeneration,
      warpFingerprint: facts.record.warpFingerprint,
    });
    if (facts.record.representationFingerprint !== recomputedRepresentation) {
      return `${label}: REPRESENTATION_FINGERPRINT_MISMATCH: published representation fingerprint disagrees with the typed record.`;
    }
    return null;
  };

  const baselineHarnessFailure = validateSide('baseline', before, canonicalBefore);
  if (baselineHarnessFailure !== null) {
    return unusable('GEOMETRY_TRANSFORM_INVALID', baselineHarnessFailure, {
      targetId: input.targetId,
      side: 'baseline',
    });
  }
  const observedHarnessFailure = validateSide('observed', after, canonicalAfter);
  if (observedHarnessFailure !== null) {
    return unusable('GEOMETRY_TRANSFORM_INVALID', observedHarnessFailure, {
      targetId: input.targetId,
      side: 'observed',
    });
  }

  // ── Canonical recomputation and renderer agreement ────────────────────────
  const canonicalLayoutBefore = canonicalCircleControlEnvelopeLayoutQuad(
    canonicalInputFromLayer(canonicalBefore),
  );
  const canonicalLayoutAfter = canonicalCircleControlEnvelopeLayoutQuad(
    canonicalInputFromLayer(canonicalAfter),
  );
  if (canonicalLayoutBefore === null || canonicalLayoutAfter === null) {
    return unusable(
      'GEOMETRY_TRANSFORM_INVALID',
      'The canonical padding-free envelope transform is unavailable.',
      { targetId: input.targetId },
    );
  }

  const maxCanonicalDeviation = Math.max(
    maxPointAxisDifference(canonicalLayoutBefore, before.record.layoutLocal),
    maxPointAxisDifference(canonicalLayoutAfter, after.record.layoutLocal),
  );
  if (maxCanonicalDeviation > CANONICAL_EXACT_TOLERANCE) {
    const summary = (canonicalQuad: Quad, bridgeQuad: Quad): string =>
      JSON.stringify(
        [0, 1, 2, 3].map((index) => ({
          i: index,
          c: canonicalQuad[index],
          b: bridgeQuad[index],
        })),
      );
    diagnostics.push(
      createDiagnostic(
        'ORACLE_SOURCE_DISAGREEMENT',
        `The bridge Layout-local circle envelope disagrees with the snapshot-derived canonical envelope by ${maxCanonicalDeviation} units (> ${CANONICAL_EXACT_TOLERANCE}).`,
        {
          context: {
            checkId: 'geometry.warp-envelope',
            baseline: summary(canonicalLayoutBefore, before.record.layoutLocal),
            observed: summary(canonicalLayoutAfter, after.record.layoutLocal),
            baselineMatrix: JSON.stringify(before.record.matrices.subjectFrameToLayout),
            observedMatrix: JSON.stringify(after.record.matrices.subjectFrameToLayout),
            baselineProjection: JSON.stringify(before.record.projection),
            observedProjection: JSON.stringify(after.record.projection),
            baselineTarget: before.provenance.target.fingerprint,
            observedTarget: after.provenance.target.fingerprint,
            baselineLayout: before.provenance.layout.fingerprint,
            observedLayout: after.provenance.layout.fingerprint,
          },
        },
      ),
    );
    envelopeFailures.push('canonical-layout-local-disagreement');
  }

  // The canonical points must also agree in the common browser-client CSS space.
  const chainAfter = layoutToBrowserMatrix(after.record);
  const canonicalBrowserBefore = transformQuad(chainAfter, canonicalLayoutBefore);
  const canonicalBrowserAfter = transformQuad(chainAfter, canonicalLayoutAfter);
  const maxRenderedDeviation = Math.max(
    maxPointAxisDifference(canonicalBrowserBefore, before.record.browserClientCss),
    maxPointAxisDifference(canonicalBrowserAfter, after.record.browserClientCss),
  );
  const renderedAgrees = maxRenderedDeviation <= RENDER_TRANSFORM_CSS_TOLERANCE;
  if (!renderedAgrees) {
    diagnostics.push(
      createDiagnostic(
        'ORACLE_SOURCE_DISAGREEMENT',
        `The bridge browser-client circle envelope disagrees with the canonical envelope projected through the Layout-to-browser chain by ${maxRenderedDeviation} CSS px (> ${RENDER_TRANSFORM_CSS_TOLERANCE}).`,
        { context: { checkId: 'geometry.warp-envelope' } },
      ),
    );
    envelopeFailures.push('canonical-browser-client-disagreement');
  }

  // ── Representation shape, winding, rigidity, and warp fingerprint ─────────
  const observedQuad = after.record.layoutLocal;
  if (
    !quadHasOnlyFinitePoints(observedQuad) ||
    !quadHasOnlyFinitePoints(before.record.layoutLocal)
  ) {
    envelopeFailures.push('non-finite-envelope');
  }
  if (!quadIsSimple(observedQuad) || !quadIsSimple(before.record.layoutLocal)) {
    envelopeFailures.push('non-convex-or-self-intersecting-envelope');
  }
  if (quadArea(observedQuad) <= 1 || quadArea(before.record.layoutLocal) <= 1) {
    envelopeFailures.push('degenerate-envelope-area');
  }
  const expectedWinding = determinantParity(after.record.matrices.warpControlToSubjectFrame);
  const baselineWinding = quadWindingSign(before.record.layoutLocal);
  const observedWinding = quadWindingSign(observedQuad);
  if (
    baselineWinding === 0 ||
    observedWinding === 0 ||
    baselineWinding !== observedWinding ||
    (expectedWinding !== 0 && observedWinding !== expectedWinding)
  ) {
    envelopeFailures.push('winding-mismatch');
  }
  if (before.record.warpFingerprint !== after.record.warpFingerprint) {
    envelopeFailures.push('warp-fingerprint-changed');
  }
  if (
    before.record.kind !== after.record.kind ||
    before.record.pointOrder.join(',') !== after.record.pointOrder.join(',') ||
    before.record.warpType !== after.record.warpType
  ) {
    envelopeFailures.push('representation-identity-changed');
  }
  if (maxEdgeDifference(before.record.layoutLocal, observedQuad) > CANONICAL_EXACT_TOLERANCE) {
    envelopeFailures.push('envelope-not-rigidly-translated');
  }
  if (before.provenance.bridgeGeneration !== after.provenance.bridgeGeneration) {
    envelopeFailures.push('bridge-generation-changed');
  }
  // The raw control box must be identical because only placement may change.
  if (maxPointAxisDifference(before.record.warpControlLocal, after.record.warpControlLocal) > 0) {
    envelopeFailures.push('warp-control-box-changed');
  }

  // ── Delta ─────────────────────────────────────────────────────────────────
  const canonicalDelta: GeometryPoint = {
    x: canonicalAfter.xCoordinate - canonicalBefore.xCoordinate,
    y: canonicalAfter.yCoordinate - canonicalBefore.yCoordinate,
  };
  const canonicalMet =
    canonicalDelta.x >= input.minimumDelta.x - CANONICAL_EXACT_TOLERANCE &&
    canonicalDelta.y >= input.minimumDelta.y - CANONICAL_EXACT_TOLERANCE;

  const expectedRendererDelta = applyAffine(linearPart(chainAfter), canonicalDelta);
  const rendererDeltaPerPoint: GeometryPoint[] = [0, 1, 2, 3].map((index) => ({
    x: after.record.browserClientCss[index].x - before.record.browserClientCss[index].x,
    y: after.record.browserClientCss[index].y - before.record.browserClientCss[index].y,
  }));
  let maxPointAxisDeviation = 0;
  for (const delta of rendererDeltaPerPoint) {
    maxPointAxisDeviation = Math.max(
      maxPointAxisDeviation,
      Math.abs(delta.x - expectedRendererDelta.x),
      Math.abs(delta.y - expectedRendererDelta.y),
    );
  }
  const rendererMet = maxPointAxisDeviation <= RENDER_TRANSFORM_CSS_TOLERANCE;
  if (!rendererMet) {
    diagnostics.push(
      createDiagnostic(
        'ORACLE_SOURCE_DISAGREEMENT',
        `Rendered browser-client movement deviates from the canonical translation projected through the unchanged Layout-to-browser linear matrix by ${maxPointAxisDeviation} CSS px (> ${RENDER_TRANSFORM_CSS_TOLERANCE}).`,
        { context: { checkId: 'geometry.delta' } },
      ),
    );
  }

  const deltaPassed = canonicalMet && rendererMet;
  const envelopePassed = envelopeFailures.length === 0;

  if (!deltaPassed) {
    diagnostics.push(
      createDiagnostic(
        'UNUSABLE_EVIDENCE',
        `geometry.delta failed: canonicalMet=${String(canonicalMet)} (Δ ${canonicalDelta.x.toFixed(3)}, ${canonicalDelta.y.toFixed(3)} vs required ≥ ${input.minimumDelta.x}, ${input.minimumDelta.y}), rendererMet=${String(rendererMet)} (max deviation ${maxPointAxisDeviation.toFixed(3)} CSS px).`,
        { context: { checkId: 'geometry.delta' } },
      ),
    );
  }
  if (!envelopePassed) {
    diagnostics.push(
      createDiagnostic(
        'UNUSABLE_EVIDENCE',
        `geometry.warp-envelope failed: ${envelopeFailures.join(', ')}.`,
        { context: { checkId: 'geometry.warp-envelope', failures: envelopeFailures.join(',') } },
      ),
    );
  }

  return {
    profileId: WARPED_TEXT_ORACLE_PROFILE_ID,
    checks: [
      { checkId: 'geometry.delta', passed: deltaPassed },
      { checkId: 'geometry.warp-envelope', passed: envelopePassed },
    ],
    requiredSourcesAgree: rendererMet && maxCanonicalDeviation <= CANONICAL_EXACT_TOLERANCE,
    harnessInvalid: false,
    diagnostics,
    delta: {
      canonicalDelta,
      canonicalMet,
      expectedRendererDelta,
      maxPointAxisDeviation,
      rendererDeltaPerPoint,
    },
    envelope: {
      baselineFingerprint: before.record.representationFingerprint,
      observedFingerprint: after.record.representationFingerprint,
      maxCanonicalDeviation,
      maxRenderedDeviation,
    },
    primitiveFacts: {
      authority: 'current',
      canonicalSourcesAgree: maxCanonicalDeviation <= CANONICAL_EXACT_TOLERANCE,
      rendererSourcesAgree: rendererMet,
      measured: {
        canonicalDelta,
        minimumDelta: { x: input.minimumDelta.x, y: input.minimumDelta.y },
        maxPointAxisDeviation,
        maxCanonicalDeviation,
        maxRenderedDeviation,
        envelopeFailures: Object.freeze([...envelopeFailures]),
      },
      tolerances: primitiveTolerances(),
      checks: [
        { checkId: 'geometry.delta', predicateMet: deltaPassed },
        { checkId: 'geometry.warp-envelope', predicateMet: envelopePassed },
      ],
    },
  };
}

/** Oracle profile identity, recorded with every evaluation. */
export const WARPED_TEXT_ORACLE_PROFILE = Object.freeze({
  profileId: WARPED_TEXT_ORACLE_PROFILE_ID,
  canonicalTolerance: CANONICAL_EXACT_TOLERANCE,
  rendererTolerance: RENDER_TRANSFORM_CSS_TOLERANCE,
});
