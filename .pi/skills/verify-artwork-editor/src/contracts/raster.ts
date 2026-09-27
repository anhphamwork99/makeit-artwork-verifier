/**
 * Raster evidence contract (WP5 Slice 5-E bridge v7; raster schema v3).
 *
 * The toolkit owns the closed interpretation of the asynchronous raster schema
 * v2 the read-only bridge publishes through `raster(id)`: the probe-set identity,
 * the exact sampling math, a hostile structural validator, and the precise
 * diagnostic each unusable/ambiguous authority shape maps to.
 *
 * The probe set is manifest-neutral: the toolkit knows positions and the
 * sampling algorithm, never a fixture's expected channel values or resource
 * identity. Expected values live only in the resource manifest the Oracle reads.
 */

import { createDiagnostic, type DiagnosticRecord } from './diagnostics';

/** Raster schema the bridge must publish (raster schema v3 / bridge v7). */
export const ARTWORK_VERIFICATION_RASTER_SCHEMA_VERSION = 3;

/** Durable legacy raster schema (v2). Read-only; never accepted live. */
export const ARTWORK_VERIFICATION_RASTER_LEGACY_SCHEMA_VERSION = 2;

/** Closed authority-kind discriminant of the raster v3 union (ADR 0017 R11). */
export const RASTER_AUTHORITY_KINDS = [
  'image-source-v2',
  'generated-vector-projection-v1',
] as const;
export type RasterAuthorityKind = (typeof RASTER_AUTHORITY_KINDS)[number];

/**
 * The only mounted-node projection method the generated-vector arm may declare
 * (ADR 0017 R12). Seam-unique.
 */
export const GENERATED_VECTOR_PROJECTION_METHOD = 'konva-mounted-node-to-canvas-v1';

/** The only coordinate space a generated-vector region may declare. */
export const GENERATED_VECTOR_COORDINATE_SPACE = 'stage-viewport-css';

/**
 * Projection pixel ratio of the generated-vector arm (ADR 0017 R12). The
 * mounted-node projection is rasterized at DPR 1 into an owned transient
 * canvas, so both published backing scales must equal this exact value.
 */
export const GENERATED_VECTOR_PROJECTION_PIXEL_RATIO = 1;

/** Explicit crop origin and backing dimensions of one generated-vector projection. */
export interface GeneratedVectorProjectionQuantization {
  /** Integer CSS-px crop origin; the CSS point that maps to backing pixel (0,0). */
  originX: number;
  originY: number;
  /** Exact backing width: `ceil(region.width × backingScaleX)`. */
  backingWidth: number;
  /** Exact backing height: `ceil(region.height × backingScaleY)`. */
  backingHeight: number;
}

/**
 * Exact quantization contract for one generated-vector region (ADR 0017 R12).
 *
 * ```text
 * originX       = floor(region.x)         originY = floor(region.y)
 * backingWidth  = ceil(region.width  × backingScaleX)
 * backingHeight = ceil(region.height × backingScaleY)
 * ```
 *
 * The region publishes the exact (unquantized) mounted target bounds so the
 * Oracle can require `RENDER_TRANSFORM_CSS` edge/point agreement. The crop
 * origin is the CSS point that maps to backing pixel (0,0), and the projection
 * covers `origin + backing / scale` CSS px, which always contains the region.
 * All arithmetic is IEEE-754 double precision with no epsilon allowance, so
 * this recomputation is the exact authority a record must reproduce.
 */
export function generatedVectorProjectionQuantization(region: {
  x: number;
  y: number;
  width: number;
  height: number;
  backingScaleX: number;
  backingScaleY: number;
}): GeneratedVectorProjectionQuantization {
  return {
    originX: Math.floor(region.x),
    originY: Math.floor(region.y),
    backingWidth: Math.ceil(region.width * region.backingScaleX),
    backingHeight: Math.ceil(region.height * region.backingScaleY),
  };
}

/** The single manifest-neutral probe set the bridge publishes. */
export const RASTER_PROBE_SET_ID = 'rgba-probes-v1';

export interface RasterProbeRational {
  numerator: number;
  denominator: number;
}

export interface RasterProbeDefinition {
  id: string;
  x: RasterProbeRational;
  y: RasterProbeRational;
}

/** Mirrors the product's closed probe set exactly (supervisor R3). */
export const RASTER_PROBE_SET: readonly RasterProbeDefinition[] = Object.freeze([
  { id: 'upper-left', x: { numerator: 1, denominator: 16 }, y: { numerator: 1, denominator: 12 } },
  {
    id: 'upper-right',
    x: { numerator: 11, denominator: 16 },
    y: { numerator: 1, denominator: 12 },
  },
  { id: 'lower-left', x: { numerator: 1, denominator: 16 }, y: { numerator: 3, denominator: 4 } },
  { id: 'lower-right', x: { numerator: 11, denominator: 16 }, y: { numerator: 3, denominator: 4 } },
]);

/** Derived backing-pixel coordinate for one normalized rational. */
export function rasterProbeBackingCoordinate(
  size: number,
  numerator: number,
  denominator: number,
): number {
  if (!Number.isFinite(size) || size <= 0) return 0;
  const derived = Math.floor((size * numerator) / denominator);
  return Math.min(Math.trunc(size) - 1, Math.max(0, derived));
}

export type RasterStatus = 'not-applicable' | 'pending' | 'ready' | 'failed' | 'torn';

export const RASTER_STATUSES: readonly RasterStatus[] = [
  'not-applicable',
  'pending',
  'ready',
  'failed',
  'torn',
];

export interface RasterProbeResultView {
  probeSetId: string;
  probeId: string;
  x: RasterProbeRational;
  y: RasterProbeRational;
  backingX: number;
  backingY: number;
  rgba: readonly [number, number, number, number];
}

export interface RasterSourceView {
  scheme: 'blob';
  mimeType: string;
  byteLength: number;
  sha256: string;
  decodedWidth: number;
  decodedHeight: number;
  sourceFingerprint: string;
}

export interface RasterRenderedView {
  nodeClass: 'Image';
  drawnWidth: number;
  drawnHeight: number;
  backingWidth: number;
  backingHeight: number;
  rgbaByteLength: number;
  rgbaSha256: string;
  nonTransparentPixelCount: number;
  probes: readonly RasterProbeResultView[];
}

export interface RasterObservationView {
  schemaVersion: number;
  documentId: string;
  documentEpoch: number;
  bridgeVersion: number;
  bridgeGeneration: number;
  revision: number;
}

export interface RasterCaptureView {
  started: RasterObservationView;
  completed: RasterObservationView;
  sourceStable: boolean;
  rendererStable: boolean;
}

export interface RasterRendererView {
  bridgeGeneration: number;
  stageFingerprint: string;
  targetFingerprint: string;
  target?: { id?: unknown; nodeClass?: unknown; x?: unknown; y?: unknown } | null;
}

export interface RasterV3HeaderView {
  rasterSchemaVersion: number;
  authorityKind: RasterAuthorityKind;
  observation: RasterObservationView;
  id: string;
  kind: string;
  mounted: boolean;
  status: RasterStatus;
  reason?: string;
  renderer: RasterRendererView;
  rasterFingerprint: string;
}

/** Accepted Image arm of the raster v3 union (ADR 0017 R11). */
export interface ImageRasterRecordView extends RasterV3HeaderView {
  authorityKind: 'image-source-v2';
  source: RasterSourceView | null;
  rendered: RasterRenderedView | null;
  capture: RasterCaptureView;
}

/** Internal R0/R1 bracket of one mounted-node projection (ADR 0017 R12). */
export interface GeneratedVectorRasterCaptureView {
  method: 'konva-mounted-node-to-canvas-v1';
  started: RasterObservationView;
  completed: RasterObservationView;
  rendererStable: boolean;
  boundsStable: boolean;
}

/** Bounded mounted-node region in stage-viewport CSS pixels (ADR 0017 R12). */
export interface GeneratedVectorRasterRegionView {
  coordinateSpace: 'stage-viewport-css';
  x: number;
  y: number;
  width: number;
  height: number;
  backingScaleX: number;
  backingScaleY: number;
}

/** RGBA authority read from the owned transient projection canvas. */
export interface GeneratedVectorRasterRenderedView {
  backingWidth: number;
  backingHeight: number;
  rgbaByteLength: number;
  rgbaSha256: string;
  nonTransparentPixelCount: number;
}

/** Generated-vector projection arm of the raster v3 union (ADR 0017 R12). */
export interface GeneratedVectorRasterRecordView extends RasterV3HeaderView {
  authorityKind: 'generated-vector-projection-v1';
  kind: 'crossword';
  capture: GeneratedVectorRasterCaptureView;
  region: GeneratedVectorRasterRegionView | null;
  rendered: GeneratedVectorRasterRenderedView | null;
}

export type RasterRecordView = ImageRasterRecordView | GeneratedVectorRasterRecordView;

/**
 * Governed `RENDER_TRANSFORM_CSS` agreement tolerance (ADR 0017 R14): the raster
 * projection region must agree with the accepted live target geometry within
 * `0.25 CSS px` per corresponding edge/point. This is the only renderer
 * geometry tolerance the generated-vector arm accepts; there is no
 * quantization, AABB, or screenshot allowance.
 */
export const RENDER_TRANSFORM_CSS_TOLERANCE_PX = 0.25;

export interface RasterRegionAgreementInput {
  region: GeneratedVectorRasterRegionView;
  target: { x: number; y: number; width: number; height: number };
  tolerancePx?: number;
}

export interface RasterRegionAgreement {
  agrees: boolean;
  /** Largest deviation across the four edges and the centre point, in CSS px. */
  maxDeviationCssPx: number;
  detail: string;
}

/**
 * Compares the bounded generated-vector projection region against the accepted
 * live target geometry (ADR 0017 R14). Both rects are in stage-viewport CSS
 * pixels; the four corresponding edges and the centre point must each agree
 * within `RENDER_TRANSFORM_CSS` (default `0.25` CSS px). A disagreement is a
 * product-expectation failure of `crossword.raster-current`, never silently
 * accepted and never repaired by a later read.
 */
export function rasterRegionAgreesWithTarget(
  input: RasterRegionAgreementInput,
): RasterRegionAgreement {
  const tolerance = input.tolerancePx ?? RENDER_TRANSFORM_CSS_TOLERANCE_PX;
  const { region, target } = input;
  const regionCenterX = region.x + region.width / 2;
  const regionCenterY = region.y + region.height / 2;
  const targetCenterX = target.x + target.width / 2;
  const targetCenterY = target.y + target.height / 2;
  const deviations: readonly [string, number][] = [
    ['left', Math.abs(region.x - target.x)],
    ['top', Math.abs(region.y - target.y)],
    ['right', Math.abs(region.x + region.width - (target.x + target.width))],
    ['bottom', Math.abs(region.y + region.height - (target.y + target.height))],
    ['centerX', Math.abs(regionCenterX - targetCenterX)],
    ['centerY', Math.abs(regionCenterY - targetCenterY)],
  ];
  let maxDeviationCssPx = 0;
  let worstEdge = 'none';
  for (const [edge, deviation] of deviations) {
    if (deviation > maxDeviationCssPx) {
      maxDeviationCssPx = deviation;
      worstEdge = edge;
    }
  }
  const agrees = maxDeviationCssPx <= tolerance;
  return {
    agrees,
    maxDeviationCssPx,
    detail: agrees
      ? `Raster region agrees with the accepted target geometry within ${tolerance} CSS px (max ${maxDeviationCssPx} CSS px).`
      : `Raster region ${worstEdge} edge/point deviates ${maxDeviationCssPx} CSS px from the accepted target geometry, exceeding ${tolerance} CSS px.`,
  };
}

export interface RasterValidationResult {
  ok: boolean;
  detail: string;
  /** Precise diagnostic when authority is malformed/ambiguous/unusable. */
  diagnostic: DiagnosticRecord | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function fail(detail: string, diagnostic: DiagnosticRecord): RasterValidationResult {
  return { ok: false, detail, diagnostic };
}

/** Precise blocking diagnostic for a failed/torn record, by product reason. */
function rasterFailureDiagnostic(
  raw: Record<string, unknown>,
  status: RasterStatus,
): RasterValidationResult {
  const id = String(raw.id);
  const reason = typeof raw.reason === 'string' ? raw.reason : 'unknown';
  const byReason: Record<string, DiagnosticRecord> = {
    'ambiguous-raster-node': createDiagnostic(
      'RASTER_NODE_AMBIGUOUS',
      `Raster target "${id}" has more than one eligible Konva Image; no first-match fallback is permitted.`,
    ),
    'non-canvas-raster-source': createDiagnostic(
      'RASTER_AUTHORITY_UNUSABLE',
      `Raster target "${id}" has a unique non-canvas drawable source; no offscreen re-render fallback is permitted.`,
    ),
    'canvas-tainted': createDiagnostic(
      'RASTER_CANVAS_TAINTED',
      `Raster target "${id}" canvas is tainted; pixel authority is unusable.`,
    ),
    'source-unreadable': createDiagnostic(
      'RASTER_SOURCE_UNREADABLE',
      `Raster target "${id}" source bytes could not be read.`,
    ),
    'observation-changed': createDiagnostic(
      'RASTER_OBSERVATION_TORN',
      `Raster target "${id}" changed during acquisition; the record is torn.`,
    ),
    'renderer-changed': createDiagnostic(
      'RASTER_OBSERVATION_TORN',
      `Raster target "${id}" renderer identity changed during acquisition; the record is torn.`,
    ),
    'target-not-visible': createDiagnostic(
      'RASTER_AUTHORITY_UNUSABLE',
      `Raster target "${id}" is not visible; no rendered authority exists.`,
    ),
    'bounds-unusable': createDiagnostic(
      'RASTER_AUTHORITY_UNUSABLE',
      `Raster target "${id}" has no positive finite bounds; no bounded region can be projected.`,
    ),
    'projection-unreadable': createDiagnostic(
      'RASTER_AUTHORITY_UNUSABLE',
      `Raster target "${id}" mounted-node projection could not be read; no screenshot or reconstructed-render fallback is permitted.`,
    ),
  };
  const diagnostic =
    byReason[reason] ??
    createDiagnostic(
      'RASTER_AUTHORITY_UNUSABLE',
      `Raster target "${id}" reports ${status} (${reason}); authority is unusable.`,
    );
  return { ok: false, detail: diagnostic.detail, diagnostic };
}

function validateImageReady(record: Record<string, unknown>): RasterValidationResult {
  const source = record.source;
  const rendered = record.rendered;
  if (!isRecord(source) || source.scheme !== 'blob') {
    return fail(
      'A ready raster record must publish a blob source.',
      createDiagnostic(
        'RASTER_SOURCE_UNREADABLE',
        'A ready raster record must publish a blob source.',
      ),
    );
  }
  if (!isRecord(rendered) || rendered.nodeClass !== 'Image') {
    return fail(
      'A ready raster record must publish a canvas-backed Konva Image.',
      createDiagnostic(
        'RASTER_AUTHORITY_UNUSABLE',
        'A ready raster record must publish a canvas-backed Konva Image.',
      ),
    );
  }
  if (!isFiniteNumber(rendered.backingWidth) || !isFiniteNumber(rendered.backingHeight)) {
    return fail(
      'A ready raster record must publish finite backing dimensions.',
      createDiagnostic(
        'RASTER_SCHEMA_UNSUPPORTED',
        'A ready raster record must publish finite backing dimensions.',
      ),
    );
  }
  if (rendered.rgbaByteLength !== rendered.backingWidth * rendered.backingHeight * 4) {
    return fail(
      'Raster rgbaByteLength does not equal backingWidth * backingHeight * 4.',
      createDiagnostic(
        'RASTER_SCHEMA_UNSUPPORTED',
        'Raster rgbaByteLength does not equal backingWidth * backingHeight * 4.',
      ),
    );
  }
  if (!isNonEmptyString(source.sha256) || !isFiniteNumber(source.byteLength)) {
    return fail(
      'A ready raster source must publish a typed digest and byte length.',
      createDiagnostic(
        'RASTER_SOURCE_UNREADABLE',
        'A ready raster source must publish a typed digest and byte length.',
      ),
    );
  }
  if (!Array.isArray(rendered.probes) || rendered.probes.length !== RASTER_PROBE_SET.length) {
    return fail(
      'A ready raster record must publish exactly the closed probe set.',
      createDiagnostic(
        'RASTER_SCHEMA_UNSUPPORTED',
        'A ready raster record must publish exactly the closed probe set.',
      ),
    );
  }
  for (let index = 0; index < RASTER_PROBE_SET.length; index += 1) {
    const probe = rendered.probes[index] as unknown;
    const expected = RASTER_PROBE_SET[index] as RasterProbeDefinition;
    if (
      !isRecord(probe) ||
      probe.probeSetId !== RASTER_PROBE_SET_ID ||
      probe.probeId !== expected.id
    ) {
      return fail(
        'Raster probe identity does not match the closed rgba-probes-v1 set.',
        createDiagnostic(
          'RASTER_SCHEMA_UNSUPPORTED',
          'Raster probe identity does not match the closed rgba-probes-v1 set.',
        ),
      );
    }
    if (!isFiniteNumber(probe.backingX) || !isFiniteNumber(probe.backingY)) {
      return fail(
        'Raster probe publishes no derived backing coordinate.',
        createDiagnostic(
          'RASTER_SCHEMA_UNSUPPORTED',
          'Raster probe publishes no derived backing coordinate.',
        ),
      );
    }
    if (
      !Array.isArray(probe.rgba) ||
      probe.rgba.length !== 4 ||
      !probe.rgba.every(isFiniteNumber)
    ) {
      return fail(
        'Raster probe publishes no typed RGBA tuple.',
        createDiagnostic(
          'RASTER_SCHEMA_UNSUPPORTED',
          'Raster probe publishes no typed RGBA tuple.',
        ),
      );
    }
  }
  return { ok: true, detail: 'Raster record is structurally valid.', diagnostic: null };
}

function validateGeneratedVectorReady(record: Record<string, unknown>): RasterValidationResult {
  // The exact generated-vector Subject kind is asserted by the Subject-scoped
  // Crossword Oracle, never by this generic contract: the generic engine must
  // contain no Subject-kind branch (specification 16 Gate A). Here the arm only
  // requires a declared, non-empty kind so the record is self-describing.
  if (!isNonEmptyString(record.kind)) {
    return fail(
      'A ready generated-vector record must declare a non-empty kind.',
      createDiagnostic(
        'RASTER_SCHEMA_UNSUPPORTED',
        'A ready generated-vector record must declare a non-empty kind.',
      ),
    );
  }
  const capture = record.capture;
  if (!isRecord(capture) || capture.method !== GENERATED_VECTOR_PROJECTION_METHOD) {
    return fail(
      `A generated-vector record must declare the ${GENERATED_VECTOR_PROJECTION_METHOD} projection method.`,
      createDiagnostic(
        'RASTER_SCHEMA_UNSUPPORTED',
        `A generated-vector record must declare the ${GENERATED_VECTOR_PROJECTION_METHOD} projection method.`,
      ),
    );
  }
  if (
    !isRecord(capture.started) ||
    !isRecord(capture.completed) ||
    capture.rendererStable !== true ||
    capture.boundsStable !== true
  ) {
    return fail(
      'A ready generated-vector record must publish stable start/end anchors, renderer stability, and bounds stability.',
      createDiagnostic(
        'RASTER_OBSERVATION_TORN',
        'A ready generated-vector record must publish stable start/end anchors, renderer stability, and bounds stability.',
      ),
    );
  }
  const region = record.region;
  if (!isRecord(region) || region.coordinateSpace !== GENERATED_VECTOR_COORDINATE_SPACE) {
    return fail(
      'A ready generated-vector record must publish a stage-viewport-css region.',
      createDiagnostic(
        'RASTER_SCHEMA_UNSUPPORTED',
        'A ready generated-vector record must publish a stage-viewport-css region.',
      ),
    );
  }
  if (
    !isFiniteNumber(region.x) ||
    !isFiniteNumber(region.y) ||
    !isFiniteNumber(region.width) ||
    !isFiniteNumber(region.height) ||
    region.width <= 0 ||
    region.height <= 0
  ) {
    return fail(
      'A ready generated-vector region must publish finite coordinates and positive finite dimensions.',
      createDiagnostic(
        'RASTER_AUTHORITY_UNUSABLE',
        'A ready generated-vector region must publish finite coordinates and positive finite dimensions.',
      ),
    );
  }
  if (
    !isFiniteNumber(region.backingScaleX) ||
    !isFiniteNumber(region.backingScaleY) ||
    region.backingScaleX <= 0 ||
    region.backingScaleY <= 0
  ) {
    return fail(
      'A ready generated-vector region must publish positive finite backing scales.',
      createDiagnostic(
        'RASTER_AUTHORITY_UNUSABLE',
        'A ready generated-vector region must publish positive finite backing scales.',
      ),
    );
  }
  if (
    region.backingScaleX !== GENERATED_VECTOR_PROJECTION_PIXEL_RATIO ||
    region.backingScaleY !== GENERATED_VECTOR_PROJECTION_PIXEL_RATIO
  ) {
    return fail(
      `A ready generated-vector region must publish the ${GENERATED_VECTOR_PROJECTION_PIXEL_RATIO} projection pixel ratio on both axes.`,
      createDiagnostic(
        'RASTER_AUTHORITY_UNUSABLE',
        `Backing scales (${String(region.backingScaleX)}, ${String(region.backingScaleY)}) are not the ${GENERATED_VECTOR_PROJECTION_PIXEL_RATIO} projection pixel ratio on both axes.`,
      ),
    );
  }
  const rendered = record.rendered;
  if (!isRecord(rendered) || rendered.nodeClass !== undefined) {
    return fail(
      'A ready generated-vector record must publish a projection rendered projection (not an Image node).',
      createDiagnostic(
        'RASTER_AUTHORITY_UNUSABLE',
        'A ready generated-vector record must publish a projection rendered projection (not an Image node).',
      ),
    );
  }
  const backingWidth = rendered.backingWidth;
  const backingHeight = rendered.backingHeight;
  if (
    !isFiniteNumber(backingWidth) ||
    !isFiniteNumber(backingHeight) ||
    backingWidth <= 0 ||
    backingHeight <= 0
  ) {
    return fail(
      'A ready generated-vector record must publish positive finite backing dimensions.',
      createDiagnostic(
        'RASTER_SCHEMA_UNSUPPORTED',
        'A ready generated-vector record must publish positive finite backing dimensions.',
      ),
    );
  }
  if (!Number.isSafeInteger(backingWidth) || !Number.isSafeInteger(backingHeight)) {
    return fail(
      'A ready generated-vector record must publish integer backing dimensions.',
      createDiagnostic(
        'RASTER_SCHEMA_UNSUPPORTED',
        `Backing dimensions (${String(backingWidth)}, ${String(backingHeight)}) are not positive safe integers.`,
      ),
    );
  }
  // ADR 0017 R12: the region and the integer backing must agree exactly. The
  // validator recomputes `originX/originY = floor(region.x/y)` and
  // `backingWidth/Height = ceil(region dimension × backing scale)` in IEEE-754
  // double precision with no epsilon allowance, so a semantically inconsistent
  // record (arbitrary positive backing dimensions or a non-1 scale) can never
  // pass structural validation.
  const quantization = generatedVectorProjectionQuantization({
    x: region.x,
    y: region.y,
    width: region.width,
    height: region.height,
    backingScaleX: region.backingScaleX,
    backingScaleY: region.backingScaleY,
  });
  // Explicit crop-origin/offset semantics (ADR 0017 R12): the projection crop
  // origin is the greatest integer at or below the region position, so the
  // sub-pixel offset is always in [0, 1). This makes the origin rule part of
  // the validated contract instead of an implicit assumption.
  if (
    !Number.isSafeInteger(quantization.originX) ||
    !Number.isSafeInteger(quantization.originY) ||
    !(region.x - quantization.originX >= 0 && region.x - quantization.originX < 1) ||
    !(region.y - quantization.originY >= 0 && region.y - quantization.originY < 1)
  ) {
    return fail(
      'A ready generated-vector region must crop from its exact floor origin with a sub-pixel offset in [0, 1).',
      createDiagnostic(
        'RASTER_AUTHORITY_UNUSABLE',
        `Region origin (${String(region.x)}, ${String(region.y)}) has no exact integer floor crop origin.`,
      ),
    );
  }
  if (backingWidth !== quantization.backingWidth || backingHeight !== quantization.backingHeight) {
    return fail(
      'Raster backing dimensions do not equal the exact ceil(region dimension × backing scale) projection quantization.',
      createDiagnostic(
        'RASTER_AUTHORITY_UNUSABLE',
        `Backing (${String(backingWidth)}, ${String(backingHeight)}) does not equal the exact region quantization (${String(quantization.backingWidth)}, ${String(quantization.backingHeight)}).`,
      ),
    );
  }
  if (rendered.rgbaByteLength !== backingWidth * backingHeight * 4) {
    return fail(
      'Raster rgbaByteLength does not equal backingWidth * backingHeight * 4.',
      createDiagnostic(
        'RASTER_SCHEMA_UNSUPPORTED',
        'Raster rgbaByteLength does not equal backingWidth * backingHeight * 4.',
      ),
    );
  }
  if (!isNonEmptyString(rendered.rgbaSha256)) {
    return fail(
      'A ready generated-vector record must publish an RGBA digest.',
      createDiagnostic(
        'RASTER_SCHEMA_UNSUPPORTED',
        'A ready generated-vector record must publish an RGBA digest.',
      ),
    );
  }
  if (
    !isFiniteNumber(rendered.nonTransparentPixelCount) ||
    rendered.nonTransparentPixelCount <= 0
  ) {
    return fail(
      'A ready generated-vector record must publish a positive non-transparent pixel count.',
      createDiagnostic(
        'RASTER_AUTHORITY_UNUSABLE',
        'A ready generated-vector record must publish a positive non-transparent pixel count.',
      ),
    );
  }
  return { ok: true, detail: 'Raster record is structurally valid.', diagnostic: null };
}

/**
 * Hostile structural validation of one bridge raster record (raster schema v3
 * closed union). A malformed, ambiguous, tainted, unreadable, unsupported, or
 * torn record is `HARNESS_BLOCKED`; the returned diagnostic is the precise
 * blocking code, never a product `BUG`. A v1/v2 record — or a v3 record missing
 * the closed authority discriminant — is unsupported, so a mixed bridge/Doctor/
 * raster version can never launch.
 */
export function validateRasterRecord(raw: unknown): RasterValidationResult {
  if (!isRecord(raw)) {
    return fail(
      'bridge.raster resolved to a non-object record.',
      createDiagnostic('RASTER_SCHEMA_UNSUPPORTED', 'bridge.raster returned a non-object record.'),
    );
  }
  if (raw.rasterSchemaVersion !== ARTWORK_VERIFICATION_RASTER_SCHEMA_VERSION) {
    return fail(
      `bridge.raster schema ${String(raw.rasterSchemaVersion)} is not the required raster schema ${ARTWORK_VERIFICATION_RASTER_SCHEMA_VERSION}.`,
      createDiagnostic(
        'RASTER_SCHEMA_UNSUPPORTED',
        `bridge.raster resolved to schema ${String(raw.rasterSchemaVersion)} instead of the required raster schema ${ARTWORK_VERIFICATION_RASTER_SCHEMA_VERSION}.`,
      ),
    );
  }
  const authorityKind = raw.authorityKind;
  if (
    typeof authorityKind !== 'string' ||
    !(RASTER_AUTHORITY_KINDS as readonly string[]).includes(authorityKind)
  ) {
    return fail(
      `Raster record authorityKind ${String(authorityKind)} is not in the closed v3 union.`,
      createDiagnostic(
        'RASTER_SCHEMA_UNSUPPORTED',
        `Raster record authorityKind ${String(authorityKind)} is not in the closed v3 union (${RASTER_AUTHORITY_KINDS.join(' | ')}).`,
      ),
    );
  }
  if (!isNonEmptyString(raw.id)) {
    return fail(
      'Raster record has no target id.',
      createDiagnostic('RASTER_TARGET_ID_MISMATCH', 'Raster record has no target id.'),
    );
  }
  const status = raw.status;
  if (typeof status !== 'string' || !(RASTER_STATUSES as readonly string[]).includes(status)) {
    return fail(
      `Raster record status ${String(status)} is not in the closed vocabulary.`,
      createDiagnostic(
        'RASTER_SCHEMA_UNSUPPORTED',
        `Raster record status ${String(status)} is not in the closed vocabulary.`,
      ),
    );
  }
  if (!isRecord(raw.observation) || !isRecord(raw.renderer) || !isRecord(raw.capture)) {
    return fail(
      'Raster record is missing observation/renderer/capture provenance.',
      createDiagnostic(
        'RASTER_SCHEMA_UNSUPPORTED',
        'Raster record is missing observation/renderer/capture provenance.',
      ),
    );
  }
  if (!isNonEmptyString(raw.rasterFingerprint)) {
    return fail(
      'Raster record has no raster fingerprint.',
      createDiagnostic('RASTER_SCHEMA_UNSUPPORTED', 'Raster record has no raster fingerprint.'),
    );
  }

  if (status === 'failed' || status === 'torn') {
    return rasterFailureDiagnostic(raw, status);
  }

  if (status === 'ready') {
    return authorityKind === 'image-source-v2'
      ? validateImageReady(raw)
      : validateGeneratedVectorReady(raw);
  }

  return { ok: true, detail: 'Raster record is structurally valid.', diagnostic: null };
}

/**
 * The accepted raster authority for a target, or a blocking diagnostic. A
 * `not-applicable`/`pending` record is valid structure but provides no
 * authority, so the caller decides readiness; this only distinguishes usable
 * `ready` authority from every unusable shape.
 */
export function readAcceptedRasterAuthority(raw: unknown): {
  ok: boolean;
  record: RasterRecordView | null;
  diagnostic: DiagnosticRecord | null;
  detail: string;
} {
  const validation = validateRasterRecord(raw);
  if (!validation.ok) {
    return {
      ok: false,
      record: null,
      diagnostic: validation.diagnostic,
      detail: validation.detail,
    };
  }
  const record = raw as unknown as RasterRecordView;
  if (record.status !== 'ready') {
    return {
      ok: false,
      record,
      diagnostic: null,
      detail: `Raster target "${record.id}" reports ${record.status}${record.reason === undefined ? '' : ` (${record.reason})`}.`,
    };
  }
  return { ok: true, record, diagnostic: null, detail: 'Raster authority is ready.' };
}
