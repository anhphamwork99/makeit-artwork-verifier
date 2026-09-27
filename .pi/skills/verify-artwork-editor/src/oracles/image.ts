import {
  RASTER_PROBE_SET,
  RASTER_PROBE_SET_ID,
  rasterProbeBackingCoordinate,
  validateRasterRecord,
} from '../contracts/raster';
import type { ResourceProbe } from '../contracts/resources';
import { findCanonicalImageLayer } from '../adapters/image-specialized';
import type { RasterBracketView } from '../readiness/coherent-capture';

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

interface ImageCheckObservation extends LegacyCompositeCheck {
  readonly unusable: boolean;
  readonly detail: string;
  /** Explicit predicate derived by the check from its raw observations. */
  readonly predicateMet: boolean;
}

/** @deprecated Legacy executor-only type alias; never used for raw authority. */
export type ImageCheckResult = ImageCheckObservation;

/**
 * Image upload/replace Oracle (WP5 Slice 5-C; supervisor R6/R7/R10, design §10).
 *
 * The Oracle consumes only an accepted coherent observation and the accepted
 * raster authority. It never parses a fingerprint, never reads a route record,
 * never uses a screenshot, and never rescues a failed check with geometry or
 * source strings. Typed digest/dimension/probe fields are the authority.
 */

export const IMAGE_ORACLE_PROFILE_ID = 'image-upload-replace-v1';

/** Tolerance for canonical product-unit frame comparisons. */
export const IMAGE_CANONICAL_EXACT = 1e-6;
/** Tolerance for renderer drawn-dimension comparisons in product units. */
export const IMAGE_RENDER_EXACT = 1e-6;

export interface ImageExpectedResource {
  logicalId: string;
  version: number;
  sha256: string;
  byteLength: number;
  mimeType: string;
  dimensions: { width: number; height: number };
  probes: readonly ResourceProbe[];
}

export interface AcceptedUploadEvidence {
  sourceSha256: string;
  rgbaSha256: string;
  probes: readonly { probeId: string; rgba: readonly number[] }[];
}

export interface ImageOracleInput {
  mode: 'upload' | 'replacement';
  targetId: string;
  expectedLayoutId: string;
  expectedFrame: { x: number; y: number; width: number; height: number; rotation: number };
  expectedResource: ImageExpectedResource;
  acceptedUpload: AcceptedUploadEvidence | null;
  /**
   * Diagnostic-only impossible-expectation control (design §16.5 BUG). It is
   * applied only to the replacement checkpoint's drawn width so the upload
   * checkpoint still passes and the replacement checkpoint fails its named
   * `image.frame-stable` check after a real replacement.
   */
  expectedMinRenderedWidth?: number | null;
  baselineSnapshot: unknown;
  observedSnapshot: unknown;
  raster: RasterBracketView | null;
}

/**
 * Closed explicit authority vocabulary for the additive primitive Image Oracle
 * observations (ADR 0029 §4 B2-B). `current` means the accepted raster/source
 * authority the Oracle needed was readable and trustworthy; `malformed` means
 * it could not be read at all. This is the only authority a B2-B3 adapter may
 * read; the legacy per-check `passed`/`unusable` booleans and the aggregate
 * `harnessInvalid` flag are deliberately not part of this view.
 */
export const IMAGE_PRIMITIVE_AUTHORITIES = ['current', 'malformed'] as const;
export type ImagePrimitiveAuthority = (typeof IMAGE_PRIMITIVE_AUTHORITIES)[number];

/**
 * One explicit per-check predicate derived from the Oracle's raw digest /
 * frame / raster / probe observations. `predicateMet` is the Oracle's own
 * per-check product predicate; it is not a legacy composite check-result
 * boolean.
 */
export interface ImagePrimitiveCheckFact {
  readonly checkId: string;
  readonly predicateMet: boolean;
}

/**
 * Additive, explicitly named primitive Image evaluation facts (ADR 0029 §4
 * B2-B). They are derived from the Oracle's own raw digest/frame/raster/probe
 * observations and expose an explicit structured authority, the independent
 * page-observed / resolved-resource source-agreement primitive, and one
 * explicit predicate per selected check. No field here is a legacy composite
 * boolean check result.
 */
export interface ImagePrimitiveFacts {
  readonly authority: ImagePrimitiveAuthority;
  readonly sourceAgreement: boolean;
  readonly checks: readonly ImagePrimitiveCheckFact[];
}

export interface ImageOracleEvaluation {
  profileId: string;
  /** @deprecated Legacy composite mirror retained for staging compile only. */
  checks: readonly ImageCheckObservation[];
  harnessInvalid: boolean;
  diagnostics: { code: string; detail: string }[];
  /**
   * Additive primitive facts for the inactive B2-B3 live-fact adapter. The
   * legacy `checks`/`harnessInvalid` fields above remain for the active runtime
   * until the B2-E cutover; the adapter reads only this view.
   */
  primitiveFacts: ImagePrimitiveFacts;
}

function nearlyEqual(left: number, right: number, tolerance: number): boolean {
  return Math.abs(left - right) <= tolerance;
}

/**
 * Independent source-agreement primitive: the page-observed raster source
 * digest/dimensions equal the resolved expected resource. It is derived from
 * raw typed digest/dimension fields only, never from a check result.
 */
function rasterSourceAgreement(input: ImageOracleInput): boolean {
  const source = input.raster?.source ?? null;
  if (source === null) return false;
  return (
    source.sha256 === input.expectedResource.sha256 &&
    source.byteLength === input.expectedResource.byteLength &&
    source.mimeType === input.expectedResource.mimeType &&
    source.decodedWidth === input.expectedResource.dimensions.width &&
    source.decodedHeight === input.expectedResource.dimensions.height
  );
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function unusable(checkId: string, detail: string): ImageCheckObservation {
  return { checkId, passed: false, unusable: true, detail, predicateMet: false };
}

function passed(checkId: string, detail: string): ImageCheckObservation {
  return { checkId, passed: true, unusable: false, detail, predicateMet: true };
}

function failed(checkId: string, detail: string): ImageCheckObservation {
  return { checkId, passed: false, unusable: false, detail, predicateMet: false };
}

function semanticTransitionCheck(input: ImageOracleInput): ImageCheckObservation {
  const checkId = 'image.semantic-transition';
  const baseline = findCanonicalImageLayer(input.baselineSnapshot, input.targetId);
  const observed = findCanonicalImageLayer(input.observedSnapshot, input.targetId);
  if (baseline === null || observed === null) {
    return unusable(checkId, `Canonical layer facts for "${input.targetId}" are unavailable.`);
  }
  if (observed.parentLayoutId !== input.expectedLayoutId) {
    return failed(
      checkId,
      `Target "${input.targetId}" left its expected Layout "${input.expectedLayoutId}".`,
    );
  }
  if (!observed.placeholder || !observed.testedWithImage || observed.src === null) {
    return failed(
      checkId,
      `Target "${input.targetId}" did not reach placeholder+testedWithImage with a source.`,
    );
  }
  if (input.mode === 'upload') {
    if (baseline.src !== null || baseline.testedWithImage || !baseline.placeholder) {
      return failed(checkId, `Baseline for "${input.targetId}" was not an empty placeholder.`);
    }
  } else if (baseline.src === null || observed.src === baseline.src) {
    return failed(checkId, `Replacement did not change the source of "${input.targetId}".`);
  }
  const frameFields: (keyof typeof observed.frame)[] = ['x', 'y', 'width', 'height', 'rotation'];
  for (const field of frameFields) {
    if (!nearlyEqual(baseline.frame[field], observed.frame[field], IMAGE_CANONICAL_EXACT)) {
      return failed(
        checkId,
        `Target "${input.targetId}" frame field ${field} changed (${baseline.frame[field]} → ${observed.frame[field]}).`,
      );
    }
  }
  if (baseline.flipX !== observed.flipX || baseline.flipY !== observed.flipY) {
    return failed(checkId, `Target "${input.targetId}" flips changed.`);
  }
  return passed(checkId, `Target "${input.targetId}" reached the expected semantic transition.`);
}

function frameStableCheck(input: ImageOracleInput): ImageCheckObservation {
  const checkId = 'image.frame-stable';
  const observed = findCanonicalImageLayer(input.observedSnapshot, input.targetId);
  if (observed === null) {
    return unusable(checkId, `Canonical layer facts for "${input.targetId}" are unavailable.`);
  }
  for (const field of ['x', 'y', 'width', 'height', 'rotation'] as const) {
    if (!nearlyEqual(observed.frame[field], input.expectedFrame[field], IMAGE_CANONICAL_EXACT)) {
      return failed(
        checkId,
        `Target "${input.targetId}" frame ${field} is ${observed.frame[field]}, expected ${input.expectedFrame[field]}.`,
      );
    }
  }
  if (observed.flipX || observed.flipY) {
    return failed(checkId, `Target "${input.targetId}" is flipped.`);
  }
  const rendered = input.raster?.rendered ?? null;
  if (rendered === null) {
    return unusable(
      checkId,
      `No live raster drawn dimensions are available for "${input.targetId}".`,
    );
  }
  const drawnWidth = finiteNumber(rendered.drawnWidth);
  const drawnHeight = finiteNumber(rendered.drawnHeight);
  if (drawnWidth === null || drawnHeight === null) {
    return unusable(
      checkId,
      `Live raster drawn dimensions are not finite for "${input.targetId}".`,
    );
  }
  if (
    !nearlyEqual(drawnWidth, input.expectedFrame.width, IMAGE_RENDER_EXACT) ||
    !nearlyEqual(drawnHeight, input.expectedFrame.height, IMAGE_RENDER_EXACT)
  ) {
    return failed(
      checkId,
      `Target "${input.targetId}" rendered ${drawnWidth}x${drawnHeight}, expected ${input.expectedFrame.width}x${input.expectedFrame.height}.`,
    );
  }
  if (
    input.mode === 'replacement' &&
    typeof input.expectedMinRenderedWidth === 'number' &&
    Number.isFinite(input.expectedMinRenderedWidth) &&
    drawnWidth < input.expectedMinRenderedWidth
  ) {
    return failed(
      checkId,
      `Target "${input.targetId}" rendered width ${drawnWidth} is below the diagnostic minimum ${input.expectedMinRenderedWidth}.`,
    );
  }
  const rendererTargetId = input.raster?.renderer?.target?.id;
  if (rendererTargetId !== input.targetId) {
    return unusable(
      checkId,
      `Raster renderer target id "${String(rendererTargetId)}" does not equal "${input.targetId}".`,
    );
  }
  return passed(checkId, `Target "${input.targetId}" frame and drawn dimensions are stable.`);
}

function rasterCurrentCheck(input: ImageOracleInput): ImageCheckObservation {
  const checkId = 'image.raster-current';
  const raster = input.raster;
  if (raster === null) {
    return unusable(checkId, `No raster record was captured for "${input.targetId}".`);
  }
  const validation = validateRasterRecord(raster);
  if (!validation.ok) {
    return unusable(checkId, validation.detail);
  }
  if (raster.status !== 'ready') {
    return unusable(checkId, `Raster status is ${String(raster.status)}, not ready.`);
  }
  if (raster.authorityKind !== 'image-source-v2') {
    return unusable(
      checkId,
      `Raster target "${input.targetId}" does not publish the image-source-v2 authority arm.`,
    );
  }
  if (raster.id !== input.targetId) {
    return unusable(
      checkId,
      `Raster target id "${String(raster.id)}" does not equal "${input.targetId}".`,
    );
  }
  const source = raster.source ?? null;
  const rendered = raster.rendered ?? null;
  if (source === null || rendered === null) {
    return unusable(checkId, 'A ready raster record must publish source and rendered authority.');
  }
  if (
    source.sha256 !== input.expectedResource.sha256 ||
    source.byteLength !== input.expectedResource.byteLength ||
    source.mimeType !== input.expectedResource.mimeType ||
    source.decodedWidth !== input.expectedResource.dimensions.width ||
    source.decodedHeight !== input.expectedResource.dimensions.height
  ) {
    return failed(
      checkId,
      `Page-observed source for "${input.targetId}" does not equal the resolved resource "${input.expectedResource.logicalId}".`,
    );
  }
  const backingWidth = finiteNumber(rendered.backingWidth);
  const backingHeight = finiteNumber(rendered.backingHeight);
  const rgbaByteLength = finiteNumber(rendered.rgbaByteLength);
  const nonTransparent = finiteNumber(rendered.nonTransparentPixelCount);
  if (backingWidth === null || backingHeight === null || backingWidth <= 0 || backingHeight <= 0) {
    return unusable(
      checkId,
      `Live raster backing dimensions for "${input.targetId}" are not positive.`,
    );
  }
  if (rgbaByteLength !== backingWidth * backingHeight * 4) {
    return unusable(
      checkId,
      `Live raster rgbaByteLength ${String(rgbaByteLength)} does not equal ${backingWidth * backingHeight * 4}.`,
    );
  }
  if (nonTransparent !== backingWidth * backingHeight) {
    return failed(
      checkId,
      `Live raster for "${input.targetId}" is not fully opaque (${String(nonTransparent)} of ${backingWidth * backingHeight}).`,
    );
  }
  return passed(checkId, `Live raster for "${input.targetId}" is current and fully opaque.`);
}

function structuralVisualCheck(input: ImageOracleInput): ImageCheckObservation {
  const checkId = 'image.structural-visual';
  const rendered = input.raster?.rendered ?? null;
  if (rendered === null) {
    return unusable(checkId, `No live raster probes are available for "${input.targetId}".`);
  }
  const backingWidth = finiteNumber(rendered.backingWidth);
  const backingHeight = finiteNumber(rendered.backingHeight);
  if (backingWidth === null || backingHeight === null) {
    return unusable(
      checkId,
      `Live raster backing dimensions are unavailable for "${input.targetId}".`,
    );
  }
  const probes = (rendered as { probes?: unknown }).probes;
  if (!Array.isArray(probes)) {
    return unusable(checkId, `Live raster publishes no probe array for "${input.targetId}".`);
  }
  for (const expected of input.expectedResource.probes) {
    const actual = probes.find(
      (entry): entry is { probeId: string; backingX: number; backingY: number; rgba: number[] } =>
        typeof entry === 'object' &&
        entry !== null &&
        (entry as { probeId?: unknown }).probeId === expected.id,
    );
    if (!actual) {
      return unusable(
        checkId,
        `Live raster is missing probe "${expected.id}" for "${input.targetId}".`,
      );
    }
    const expectedX = rasterProbeBackingCoordinate(
      backingWidth,
      expected.x.numerator,
      expected.x.denominator,
    );
    const expectedY = rasterProbeBackingCoordinate(
      backingHeight,
      expected.y.numerator,
      expected.y.denominator,
    );
    if (actual.backingX !== expectedX || actual.backingY !== expectedY) {
      return unusable(
        checkId,
        `Probe "${expected.id}" backing coordinate (${actual.backingX},${actual.backingY}) does not match the derived (${expectedX},${expectedY}).`,
      );
    }
    for (let channel = 0; channel < 4; channel += 1) {
      const value = actual.rgba[channel];
      const target = expected.expectedRgba[channel] as number;
      if (typeof value !== 'number' || Math.abs(value - target) > expected.channelTolerance) {
        return failed(
          checkId,
          `Probe "${expected.id}" channel ${channel} is ${String(value)}, expected ${target} ±${expected.channelTolerance}.`,
        );
      }
    }
  }
  return passed(
    checkId,
    `Structural visual probes match the resolved resource for "${input.targetId}".`,
  );
}

function contentDistinctCheck(input: ImageOracleInput): ImageCheckObservation {
  const checkId = 'image.content-distinct';
  if (input.mode !== 'replacement')
    return passed(checkId, 'Not required on the upload checkpoint.');
  const accepted = input.acceptedUpload;
  if (accepted === null) {
    return unusable(checkId, 'Replacement distinctness requires the accepted upload evidence.');
  }
  const source = input.raster?.source ?? null;
  const rendered = input.raster?.rendered ?? null;
  if (source === null || rendered === null) {
    return unusable(
      checkId,
      'Replacement distinctness requires accepted source and rendered authority.',
    );
  }
  if (accepted.sourceSha256 === input.expectedResource.sha256) {
    return failed(checkId, 'The replacement resource digest equals the accepted upload digest.');
  }
  if (source.sha256 === accepted.sourceSha256) {
    return failed(
      checkId,
      'The page-observed replacement source digest equals the accepted upload digest.',
    );
  }
  if (rendered.rgbaSha256 === accepted.rgbaSha256) {
    return failed(
      checkId,
      'The live replacement RGBA digest equals the accepted upload RGBA digest.',
    );
  }
  const probes = (rendered as { probes?: unknown }).probes;
  const differs = Array.isArray(probes)
    ? probes.some((entry) => {
        if (typeof entry !== 'object' || entry === null) return true;
        const probe = entry as { probeId?: unknown; rgba?: unknown };
        const acceptedProbe = accepted.probes.find(
          (candidate) => candidate.probeId === probe.probeId,
        );
        if (!acceptedProbe || !Array.isArray(probe.rgba)) return true;
        return probe.rgba.some((value, channel) => value !== acceptedProbe.rgba[channel]);
      })
    : false;
  if (!differs) {
    return failed(
      checkId,
      'No structural probe differs between the upload and replacement raster.',
    );
  }
  return passed(
    checkId,
    'Replacement content is distinct from the accepted upload in bytes and pixels.',
  );
}

const CHECK_ORDER = [
  'image.semantic-transition',
  'image.raster-current',
  'image.frame-stable',
  'image.structural-visual',
  'image.content-distinct',
] as const;

export function evaluateImageOracle(input: ImageOracleInput): ImageOracleEvaluation {
  const checkModes: Record<string, boolean> = {
    'image.semantic-transition': true,
    'image.raster-current': true,
    'image.frame-stable': true,
    'image.structural-visual': true,
    'image.content-distinct': input.mode === 'replacement',
  };
  const checks: ImageCheckObservation[] = [
    semanticTransitionCheck(input),
    rasterCurrentCheck(input),
    frameStableCheck(input),
    structuralVisualCheck(input),
    contentDistinctCheck(input),
  ];
  const selected = checks.filter((check) => checkModes[check.checkId] === true);
  const diagnostics = selected
    .filter((check) => check.unusable)
    .map((check) => ({ code: 'UNUSABLE_EVIDENCE', detail: check.detail }));
  const harnessInvalid = selected.some((check) => check.unusable);
  return {
    profileId: IMAGE_ORACLE_PROFILE_ID,
    checks: selected.sort(
      (left, right) =>
        CHECK_ORDER.indexOf(left.checkId as never) - CHECK_ORDER.indexOf(right.checkId as never),
    ),
    harnessInvalid,
    diagnostics,
    primitiveFacts: {
      authority: harnessInvalid ? 'malformed' : 'current',
      sourceAgreement: rasterSourceAgreement(input),
      checks: selected.map((check) => ({
        checkId: check.checkId,
        predicateMet: check.predicateMet,
      })),
    },
  };
}

/** The closed probe-set identity the image Oracle expects. */
export const IMAGE_ORACLE_PROBE_SET_ID = RASTER_PROBE_SET_ID;
/** The closed probe set the image Oracle expects. */
export const IMAGE_ORACLE_PROBES = RASTER_PROBE_SET;
