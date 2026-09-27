import { describe, expect, it } from 'vitest';

import type { ObservationCursor } from '../../src/contracts/observation';
import {
  ARTWORK_VERIFICATION_RASTER_LEGACY_SCHEMA_VERSION,
  ARTWORK_VERIFICATION_RASTER_SCHEMA_VERSION,
  GENERATED_VECTOR_COORDINATE_SPACE,
  GENERATED_VECTOR_PROJECTION_METHOD,
  RASTER_AUTHORITY_KINDS,
  RASTER_PROBE_SET,
  RASTER_STATUSES,
  generatedVectorProjectionQuantization,
  rasterProbeBackingCoordinate,
  readAcceptedRasterAuthority,
  validateRasterRecord,
} from '../../src/contracts/raster';
import { evaluateExpectedRasterCurrentness } from '../../src/readiness/raster-currentness';
import {
  captureCoherentObservation,
  type RasterBracketView,
} from '../../src/readiness/coherent-capture';
import { DOCTOR_RESULT_SCHEMA_VERSION } from '../../src/contracts/schema-versions';
import { OBSERVATION_BRIDGE_VERSION } from '../../src/contracts/seam';

/**
 * WP5 Slice 5-E raster schema v3 closed union (ADR 0017 R11–R12).
 *
 * The v3 union is the live authority: the accepted Image arm must keep the v2
 * Image semantics, the generated-vector arm must be a bounded mounted-node
 * projection, and every mixed or malformed version must fail closed instead of
 * launching a partially migrated harness.
 */

const TARGET_ID = 'layout-a-crossword-1';

function cursor(revision = 5, bridgeVersion = OBSERVATION_BRIDGE_VERSION): ObservationCursor {
  return {
    schemaVersion: 1,
    documentId: 'doc',
    documentEpoch: 1,
    bridgeVersion,
    bridgeGeneration: 1,
    revision,
  };
}

function probes() {
  return RASTER_PROBE_SET.map((probe) => ({
    probeSetId: 'rgba-probes-v1',
    probeId: probe.id,
    x: probe.x,
    y: probe.y,
    backingX: rasterProbeBackingCoordinate(320, probe.x.numerator, probe.x.denominator),
    backingY: rasterProbeBackingCoordinate(240, probe.y.numerator, probe.y.denominator),
    rgba: [10, 20, 30, 255],
  }));
}

/** A structurally valid ready Image arm (semantic compatibility with v2). */
function imageRecord(overrides: Record<string, unknown> = {}) {
  return {
    rasterSchemaVersion: ARTWORK_VERIFICATION_RASTER_SCHEMA_VERSION,
    authorityKind: 'image-source-v2',
    observation: cursor(),
    id: 'layout-image-a-image-1',
    kind: 'image',
    mounted: true,
    status: 'ready',
    source: {
      scheme: 'blob',
      mimeType: 'image/png',
      byteLength: 8,
      sha256: 'a'.repeat(64),
      decodedWidth: 32,
      decodedHeight: 24,
      sourceFingerprint: 'raster-source-v2:abc',
    },
    rendered: {
      nodeClass: 'Image',
      drawnWidth: 320,
      drawnHeight: 240,
      backingWidth: 320,
      backingHeight: 240,
      rgbaByteLength: 320 * 240 * 4,
      rgbaSha256: 'b'.repeat(64),
      nonTransparentPixelCount: 320 * 240,
      probes: probes(),
    },
    renderer: {
      bridgeGeneration: 1,
      stageFingerprint: 'stage',
      targetFingerprint: 'target',
      target: { id: 'layout-image-a-image-1' },
    },
    capture: {
      started: cursor(),
      completed: cursor(),
      sourceStable: true,
      rendererStable: true,
    },
    rasterFingerprint: 'raster-v2:image',
    ...overrides,
  };
}

/** A structurally valid ready generated-vector projection arm. */
function generatedRecord(overrides: Record<string, unknown> = {}) {
  return {
    rasterSchemaVersion: ARTWORK_VERIFICATION_RASTER_SCHEMA_VERSION,
    authorityKind: 'generated-vector-projection-v1',
    observation: cursor(),
    id: TARGET_ID,
    kind: 'crossword',
    mounted: true,
    status: 'ready',
    capture: {
      method: GENERATED_VECTOR_PROJECTION_METHOD,
      started: cursor(),
      completed: cursor(),
      rendererStable: true,
      boundsStable: true,
    },
    region: {
      coordinateSpace: GENERATED_VECTOR_COORDINATE_SPACE,
      x: 100,
      y: 120,
      width: 320,
      height: 240,
      backingScaleX: 1,
      backingScaleY: 1,
    },
    rendered: {
      backingWidth: 320,
      backingHeight: 240,
      rgbaByteLength: 320 * 240 * 4,
      rgbaSha256: 'c'.repeat(64),
      nonTransparentPixelCount: 320 * 240,
    },
    renderer: {
      bridgeGeneration: 1,
      stageFingerprint: 'stage',
      targetFingerprint: 'target',
      target: { id: TARGET_ID },
    },
    rasterFingerprint: 'raster-v3-generated-vector:xyz',
    ...overrides,
  };
}

describe('WP5 Slice 5-E — raster v3 closed union (ADR 0017 R11)', () => {
  it('locks the live schema to v3 and the bridge/Doctor versions to v7', () => {
    expect(ARTWORK_VERIFICATION_RASTER_SCHEMA_VERSION).toBe(3);
    expect(ARTWORK_VERIFICATION_RASTER_LEGACY_SCHEMA_VERSION).toBe(2);
    expect(OBSERVATION_BRIDGE_VERSION).toBe(7);
    expect(DOCTOR_RESULT_SCHEMA_VERSION).toBe(7);
    expect(RASTER_AUTHORITY_KINDS).toEqual(['image-source-v2', 'generated-vector-projection-v1']);
    expect(GENERATED_VECTOR_PROJECTION_METHOD).toBe('konva-mounted-node-to-canvas-v1');
    expect(GENERATED_VECTOR_COORDINATE_SPACE).toBe('stage-viewport-css');
    expect(RASTER_STATUSES).toContain('torn');
  });

  it('accepts a ready Image arm with the accepted v2 Image semantics', () => {
    const validation = validateRasterRecord(imageRecord());
    expect(validation.ok).toBe(true);
    const accepted = readAcceptedRasterAuthority(imageRecord());
    expect(accepted.ok).toBe(true);
    expect(accepted.record?.authorityKind).toBe('image-source-v2');
  });

  it('accepts a ready generated-vector projection arm', () => {
    const validation = validateRasterRecord(generatedRecord());
    expect(validation.ok).toBe(true);
    const accepted = readAcceptedRasterAuthority(generatedRecord());
    expect(accepted.ok).toBe(true);
    expect(accepted.record?.authorityKind).toBe('generated-vector-projection-v1');
  });

  it('fails closed on every mixed or unsupported version', () => {
    expect(validateRasterRecord({ ...imageRecord(), rasterSchemaVersion: 1 }).ok).toBe(false);
    expect(validateRasterRecord({ ...imageRecord(), rasterSchemaVersion: 2 }).ok).toBe(false);
    expect(validateRasterRecord({ ...generatedRecord(), rasterSchemaVersion: 2 }).ok).toBe(false);
    const { authorityKind: _omitted, ...withoutAuthorityKind } = generatedRecord();
    const missing = validateRasterRecord(withoutAuthorityKind);
    expect(missing.ok).toBe(false);
    expect(missing.diagnostic?.code).toBe('RASTER_SCHEMA_UNSUPPORTED');
    const unknown = validateRasterRecord({ ...generatedRecord(), authorityKind: 'vector-v9' });
    expect(unknown.ok).toBe(false);
    expect(unknown.diagnostic?.code).toBe('RASTER_SCHEMA_UNSUPPORTED');
  });

  it('rejects an arm that lies about its shape instead of coercing it', () => {
    // An Image-shaped record claiming the generated-vector arm must not pass.
    const lying = validateRasterRecord({
      ...imageRecord(),
      authorityKind: 'generated-vector-projection-v1',
    });
    expect(lying.ok).toBe(false);
    // A generated-vector record without the mounted-node projection method.
    const wrongMethod = validateRasterRecord({
      ...generatedRecord(),
      capture: { ...generatedRecord().capture, method: 'screenshot-v1' },
    });
    expect(wrongMethod.ok).toBe(false);
    expect(wrongMethod.diagnostic?.code).toBe('RASTER_SCHEMA_UNSUPPORTED');
  });

  it('rejects unusable generated-vector regions and rendered authority', () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      [
        'wrong coordinate space',
        { region: { ...generatedRecord().region, coordinateSpace: 'viewport' } },
      ],
      ['zero width', { region: { ...generatedRecord().region, width: 0 } }],
      ['negative height', { region: { ...generatedRecord().region, height: -1 } }],
      ['zero backing scale', { region: { ...generatedRecord().region, backingScaleX: 0 } }],
      ['unequal backing scales', { region: { ...generatedRecord().region, backingScaleY: 2 } }],
      [
        'scale that is not the projection pixel ratio',
        { region: { ...generatedRecord().region, backingScaleX: 2, backingScaleY: 2 } },
      ],
      [
        'backing width below the exact quantization',
        { rendered: { ...generatedRecord().rendered, backingWidth: 319 } },
      ],
      [
        'backing width above the exact quantization',
        { rendered: { ...generatedRecord().rendered, backingWidth: 321 } },
      ],
      [
        'backing height mismatch',
        { rendered: { ...generatedRecord().rendered, backingHeight: 239 } },
      ],
      [
        'fractional backing width',
        {
          rendered: {
            ...generatedRecord().rendered,
            backingWidth: 319.5,
            rgbaByteLength: 319.5 * 240 * 4,
          },
        },
      ],
      ['byte-length mismatch', { rendered: { ...generatedRecord().rendered, rgbaByteLength: 4 } }],
      ['missing digest', { rendered: { ...generatedRecord().rendered, rgbaSha256: '' } }],
      [
        'zero non-transparent pixels',
        { rendered: { ...generatedRecord().rendered, nonTransparentPixelCount: 0 } },
      ],
      ['renderer unstable', { capture: { ...generatedRecord().capture, rendererStable: false } }],
      ['bounds unstable', { capture: { ...generatedRecord().capture, boundsStable: false } }],
      ['no region', { region: null }],
      ['no rendered authority', { rendered: null }],
    ];
    for (const [label, override] of cases) {
      expect(validateRasterRecord(generatedRecord(override)), label).toMatchObject({ ok: false });
    }
  });

  it('enforces the exact projection quantization including floor/ceil and precision boundaries', () => {
    // The helper is the single authority the validator recomputes: floor origin,
    // ceil backing, in IEEE-754 double precision with no epsilon allowance.
    expect(
      generatedVectorProjectionQuantization({
        x: 100.5,
        y: 120.25,
        width: 320.5,
        height: 240.75,
        backingScaleX: 1,
        backingScaleY: 1,
      }),
    ).toEqual({ originX: 100, originY: 120, backingWidth: 321, backingHeight: 241 });
    expect(
      generatedVectorProjectionQuantization({
        x: -0.5,
        y: 0,
        width: 1,
        height: 1,
        backingScaleX: 1,
        backingScaleY: 1,
      }),
    ).toEqual({ originX: -1, originY: 0, backingWidth: 1, backingHeight: 1 });

    // A fractional region whose exact ceil exceeds its truncated backing is
    // rejected; the matching exact quantization is accepted.
    expect(
      validateRasterRecord(
        generatedRecord({
          region: { ...generatedRecord().region, width: 320.5 },
        }),
      ).ok,
    ).toBe(false);
    const fractional = validateRasterRecord(
      generatedRecord({
        region: { ...generatedRecord().region, x: 100.5, y: 120.25, width: 320.5, height: 240.75 },
        rendered: {
          ...generatedRecord().rendered,
          backingWidth: 321,
          backingHeight: 241,
          rgbaByteLength: 321 * 241 * 4,
        },
      }),
    );
    expect(fractional.ok).toBe(true);

    // An exact boundary width is stable, while the next representable double
    // above it ceils to the next integer; both are exact, not approximate.
    const exactBoundary = validateRasterRecord(
      generatedRecord({
        region: { ...generatedRecord().region, width: 265, height: 311 },
        rendered: {
          ...generatedRecord().rendered,
          backingWidth: 265,
          backingHeight: 311,
          rgbaByteLength: 265 * 311 * 4,
        },
      }),
    );
    expect(exactBoundary.ok).toBe(true);
    const aboveBoundary = validateRasterRecord(
      generatedRecord({
        region: { ...generatedRecord().region, width: 265.00000000000006, height: 311 },
        rendered: {
          ...generatedRecord().rendered,
          backingWidth: 265,
          backingHeight: 311,
          rgbaByteLength: 265 * 311 * 4,
        },
      }),
    );
    expect(aboveBoundary.ok).toBe(false);
    const aboveBoundaryExact = validateRasterRecord(
      generatedRecord({
        region: { ...generatedRecord().region, width: 265.00000000000006, height: 311 },
        rendered: {
          ...generatedRecord().rendered,
          backingWidth: 266,
          backingHeight: 311,
          rgbaByteLength: 266 * 311 * 4,
        },
      }),
    );
    expect(aboveBoundaryExact.ok).toBe(true);
  });

  it('maps a torn generated-vector record onto the torn blocking diagnostic', () => {
    const torn = validateRasterRecord({
      ...generatedRecord(),
      status: 'torn',
      reason: 'observation-changed',
    });
    expect(torn.ok).toBe(false);
    expect(torn.diagnostic?.code).toBe('RASTER_OBSERVATION_TORN');
    const unreadable = validateRasterRecord({
      ...generatedRecord(),
      status: 'failed',
      reason: 'projection-unreadable',
    });
    expect(unreadable.ok).toBe(false);
    expect(unreadable.diagnostic?.code).toBe('RASTER_AUTHORITY_UNUSABLE');
  });

  it('keeps the Image currentness evaluator on the Image arm only', () => {
    const expected = {
      sha256: 'a'.repeat(64),
      byteLength: 8,
      mimeType: 'image/png',
      dimensions: { width: 32, height: 24 },
      probes: RASTER_PROBE_SET.map((probe) => ({
        id: probe.id,
        x: probe.x,
        y: probe.y,
        expectedRgba: [10, 20, 30, 255],
        channelTolerance: 0,
      })),
    };
    const generated = evaluateExpectedRasterCurrentness({
      raster: generatedRecord() as unknown as RasterBracketView,
      targetId: TARGET_ID,
      expectedResource: expected,
      expectedFrame: { x: 100, y: 120, width: 320, height: 240, rotation: 0 },
      mode: 'upload',
      acceptedUpload: null,
    });
    expect(generated.status).toBe('unusable');
    expect(generated.diagnostic?.code).toBe('RASTER_AUTHORITY_UNUSABLE');

    const accepted = evaluateExpectedRasterCurrentness({
      raster: imageRecord() as unknown as RasterBracketView,
      targetId: 'layout-image-a-image-1',
      expectedResource: expected,
      expectedFrame: { x: 90, y: 110, width: 320, height: 240, rotation: 0 },
      mode: 'upload',
      acceptedUpload: null,
    });
    // Structurally usable, and converging on the expected fully-opaque resource.
    expect(['converged', 'mismatch']).toContain(accepted.status);
  });

  it('brackets a generated-vector arm by its own renderer/bounds stability facts', async () => {
    const geometry = {
      id: TARGET_ID,
      observation: cursor(),
      mounted: true,
      visible: true,
      listening: true,
      hitPoint: { x: 1, y: 1 },
      viewportRect: { x: 0, y: 0, width: 10, height: 10 },
    };
    const result = await captureCoherentObservation({
      now: () => 0,
      deadlineAt: 1_000,
      readCursor: async () => cursor(),
      readSnapshot: async () => ({ observation: cursor() }),
      readGeometry: async () => geometry,
      readRaster: async () => generatedRecord() as unknown as RasterBracketView,
      targetIds: [TARGET_ID],
      stableRendererFingerprint: null,
      allocateObservationId: () => 'obs-crossword-1',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.observation.observationId).toBe('obs-crossword-1');
      expect(result.observation.raster[TARGET_ID]).toBeDefined();
    }
  });

  it('tears a generated-vector bracket when bounds stability is not reported', async () => {
    const geometry = {
      id: TARGET_ID,
      observation: cursor(),
      mounted: true,
      visible: true,
      listening: true,
      hitPoint: { x: 1, y: 1 },
      viewportRect: { x: 0, y: 0, width: 10, height: 10 },
    };
    const result = await captureCoherentObservation({
      now: () => 0,
      deadlineAt: 0,
      readCursor: async () => cursor(),
      readSnapshot: async () => ({ observation: cursor() }),
      readGeometry: async () => geometry,
      readRaster: async () =>
        generatedRecord({
          capture: { ...generatedRecord().capture, boundsStable: false },
        }) as unknown as RasterBracketView,
      targetIds: [TARGET_ID],
      stableRendererFingerprint: null,
      allocateObservationId: () => 'obs-crossword-2',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.torn[0]?.reason).toBe('raster-bracket-tear');
  });
});
