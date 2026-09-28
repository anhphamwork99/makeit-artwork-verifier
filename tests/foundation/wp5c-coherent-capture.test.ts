import { describe, expect, it, vi } from 'vitest';

import type { ObservationCursor } from '../../src/contracts/observation';
import {
  captureCoherentObservation,
  type CoherentCaptureDeps,
  type RasterBracketView,
  type StableRendererFingerprint,
  type StampedGeometryView,
  type StampedSnapshotView,
} from '../../src/readiness/coherent-capture';

/**
 * Supervisor R13 required test matrix — dedicated named test 41.
 *
 * Proves the accepted A0 → snapshot → G0 → G1 → R0 → R1 → A1 bracket, each
 * raster capture's internal start/end anchors, and the idle-provenance
 * equality, plus one-field disagreement cases that become torn and receive no
 * `observationId`.
 */

const TARGET_ID = 'layout-image-a-image-1';

function cursor(overrides: Partial<ObservationCursor> = {}): ObservationCursor {
  return {
    schemaVersion: 1,
    documentId: 'doc-1',
    documentEpoch: 1,
    bridgeVersion: 5,
    bridgeGeneration: 3,
    revision: 10,
    ...overrides,
  };
}

function stableFingerprint(
  overrides: Partial<StableRendererFingerprint> = {},
): StableRendererFingerprint {
  return {
    bridgeGeneration: 3,
    stageFingerprint: 'stage-1',
    targetFingerprints: { [TARGET_ID]: 'geom-1' },
    ...overrides,
  };
}

function geometry(overrides: Partial<StampedGeometryView> = {}): StampedGeometryView {
  return {
    observation: cursor(),
    id: TARGET_ID,
    mounted: true,
    visible: true,
    listening: true,
    renderer: {
      bridgeGeneration: 3,
      stageFingerprint: 'stage-1',
      targetFingerprint: 'geom-1',
      target: { id: TARGET_ID, x: 10, y: 20 },
    },
    ...overrides,
  };
}

function raster(overrides: Partial<RasterBracketView> = {}): RasterBracketView {
  return {
    rasterSchemaVersion: 3,
    authorityKind: 'image-source-v2',
    observation: cursor(),
    id: TARGET_ID,
    status: 'ready',
    source: {
      sha256: 'src-a',
      byteLength: 8,
      mimeType: 'image/png',
      decodedWidth: 32,
      decodedHeight: 24,
    },
    rendered: {
      rgbaSha256: 'rgba-a',
      rgbaByteLength: 320 * 240 * 4,
      backingWidth: 320,
      backingHeight: 240,
      nonTransparentPixelCount: 320 * 240,
      drawnWidth: 320,
      drawnHeight: 240,
      probes: [
        {
          probeSetId: 'rgba-probes-v1',
          probeId: 'upper-left',
          backingX: 20,
          backingY: 20,
          rgba: [1, 2, 3, 255],
        },
        {
          probeSetId: 'rgba-probes-v1',
          probeId: 'upper-right',
          backingX: 220,
          backingY: 20,
          rgba: [4, 5, 6, 255],
        },
        {
          probeSetId: 'rgba-probes-v1',
          probeId: 'lower-left',
          backingX: 20,
          backingY: 180,
          rgba: [7, 8, 9, 255],
        },
        {
          probeSetId: 'rgba-probes-v1',
          probeId: 'lower-right',
          backingX: 220,
          backingY: 180,
          rgba: [10, 11, 12, 255],
        },
      ],
    },
    renderer: { bridgeGeneration: 3, targetFingerprint: 'geom-1', target: { id: TARGET_ID } },
    capture: {
      started: cursor(),
      completed: cursor(),
      sourceStable: true,
      rendererStable: true,
    },
    rasterFingerprint: 'raster-a',
    ...overrides,
  };
}

function snapshot(overrides: Partial<StampedSnapshotView> = {}): StampedSnapshotView {
  return { observation: cursor(), ...overrides };
}

interface DepsOptions {
  cursorReads?: readonly ObservationCursor[];
  snapshot?: StampedSnapshotView;
  geometryReads?: readonly StampedGeometryView[];
  rasterReads?: readonly RasterBracketView[];
  stable?: StableRendererFingerprint | null;
  targetIds?: readonly string[];
  now?: () => number;
  deadlineAt?: number;
  allocateObservationId?: () => string;
}

function makeDeps(options: DepsOptions = {}): CoherentCaptureDeps {
  let cursorIndex = 0;
  let geometryIndex = 0;
  let rasterIndex = 0;
  const cursorReads = options.cursorReads ?? [cursor(), cursor()];
  const geometryReads = options.geometryReads ?? [geometry(), geometry()];
  const rasterReads = options.rasterReads ?? [raster(), raster()];
  return {
    now: options.now ?? (() => 0),
    deadlineAt: options.deadlineAt ?? 1_000,
    readCursor: async () =>
      cursorReads[Math.min(cursorIndex++, cursorReads.length - 1)] as ObservationCursor,
    readSnapshot: async () => options.snapshot ?? snapshot(),
    readGeometry: async () =>
      geometryReads[Math.min(geometryIndex++, geometryReads.length - 1)] as StampedGeometryView,
    targetIds: options.targetIds ?? [TARGET_ID],
    stableRendererFingerprint: options.stable === undefined ? stableFingerprint() : options.stable,
    readRaster: async () =>
      rasterReads[Math.min(rasterIndex++, rasterReads.length - 1)] as RasterBracketView,
    allocateObservationId: options.allocateObservationId ?? (() => 'obs-1'),
  };
}

describe('test 41 — full A0 snapshot G0 G1 R0 R1 A1 and idle provenance agree', () => {
  it('accepts the full bracket and stamps every anchor with the one cursor', async () => {
    const allocate = vi.fn(() => 'obs-1');
    const result = await captureCoherentObservation(makeDeps({ allocateObservationId: allocate }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.observation.observationId).toBe('obs-1');
    expect(allocate).toHaveBeenCalledTimes(1);
    // Outer anchors: snapshot, G1 and R1 all carry the accepted A0 cursor.
    expect(result.observation.cursor).toEqual(cursor());
    expect(result.observation.snapshot.observation).toEqual(cursor());
    expect(result.observation.geometry[TARGET_ID]?.observation).toEqual(cursor());
    // Each raster capture's internal start/end anchors are retained and agree
    // field-for-field with anchor A0 and with each other.
    const acceptedRaster = result.observation.raster[TARGET_ID];
    expect(acceptedRaster?.observation).toEqual(cursor());
    expect(acceptedRaster?.rasterFingerprint).toBe('raster-a');
    expect(acceptedRaster?.capture?.started).toEqual(cursor());
    expect(acceptedRaster?.capture?.completed).toEqual(cursor());
    expect(acceptedRaster?.capture?.started).toEqual(acceptedRaster?.capture?.completed);
    expect(acceptedRaster?.capture?.sourceStable).toBe(true);
    expect(acceptedRaster?.capture?.rendererStable).toBe(true);
    expect(acceptedRaster?.capture?.started?.documentId).toBe(result.observation.cursor.documentId);
    expect(acceptedRaster?.capture?.completed?.bridgeGeneration).toBe(
      result.observation.cursor.bridgeGeneration,
    );
    expect(acceptedRaster?.capture?.completed?.revision).toBe(result.observation.cursor.revision);
    // Target, document, cursor, generation, renderer and idle provenance agree.
    expect(result.observation.geometry[TARGET_ID]?.id).toBe(TARGET_ID);
    expect(result.observation.geometry[TARGET_ID]?.renderer?.bridgeGeneration).toBe(3);
    expect(result.observation.geometry[TARGET_ID]?.renderer?.stageFingerprint).toBe('stage-1');
    expect(result.observation.geometry[TARGET_ID]?.renderer?.targetFingerprint).toBe('geom-1');
    expect(result.observation.geometry[TARGET_ID]?.renderer?.target?.id).toBe(TARGET_ID);
    expect(acceptedRaster?.renderer?.target?.id).toBe(TARGET_ID);
    // The idle (stable) fingerprint the quiescence stage established equals the
    // captured renderer facts.
    const stable = stableFingerprint();
    const renderer = result.observation.geometry[TARGET_ID]?.renderer;
    expect(renderer?.bridgeGeneration).toBe(stable.bridgeGeneration);
    expect(renderer?.stageFingerprint).toBe(stable.stageFingerprint);
    expect(renderer?.targetFingerprint).toBe(stable.targetFingerprints[TARGET_ID]);
  });

  it('reads raster R0 and R1 with identical retained internal anchors on the accepted path', async () => {
    const reads: { observation: number; started: number; completed: number }[] = [];
    const deps = makeDeps();
    const original = deps.readRaster as (id: string) => Promise<RasterBracketView>;
    deps.readRaster = async (id) => {
      const value = await original(id);
      reads.push({
        observation: value.observation?.revision as number,
        started: value.capture?.started?.revision as number,
        completed: value.capture?.completed?.revision as number,
      });
      return value;
    };
    const result = await captureCoherentObservation(deps);
    expect(result.ok).toBe(true);
    expect(reads).toEqual([
      { observation: 10, started: 10, completed: 10 },
      { observation: 10, started: 10, completed: 10 },
    ]);
  });

  it.each([
    [
      'document identity',
      { cursorReads: [cursor(), cursor({ documentId: 'doc-2' })] },
      'document-tear',
    ],
    [
      'bridge generation',
      { cursorReads: [cursor(), cursor({ bridgeGeneration: 4 })] },
      'generation-tear',
    ],
    [
      'store revision',
      { cursorReads: [cursor(), cursor({ revision: 11 })] },
      'store-revision-tear',
    ],
    [
      'snapshot stamp',
      { snapshot: snapshot({ observation: cursor({ revision: 9 }) }) },
      'store-revision-tear',
    ],
    [
      'renderer generation',
      {
        geometryReads: [
          geometry({
            renderer: {
              bridgeGeneration: 4,
              stageFingerprint: 'stage-1',
              targetFingerprint: 'geom-1',
            },
          }),
          geometry({
            renderer: {
              bridgeGeneration: 4,
              stageFingerprint: 'stage-1',
              targetFingerprint: 'geom-1',
            },
          }),
        ],
      },
      'renderer-provenance-tear',
    ],
    [
      'typed geometry bracket',
      {
        geometryReads: [
          geometry({ geometryV2: { envelopeFingerprint: 'env-1' } }),
          geometry({ geometryV2: { envelopeFingerprint: 'env-2' } }),
        ],
      },
      'geometry-bracket-tear',
    ],
    [
      'raster fingerprint',
      {
        rasterReads: [raster(), raster({ rasterFingerprint: 'raster-b' })],
      },
      'raster-bracket-tear',
    ],
    [
      'raster source digest',
      {
        rasterReads: [raster(), raster({ source: { sha256: 'src-b' } })],
      },
      'raster-bracket-tear',
    ],
    [
      'raster anchor',
      {
        rasterReads: [raster(), raster({ observation: cursor({ revision: 11 }) })],
      },
      'raster-bracket-tear',
    ],
    [
      'raster internal start/end anchor',
      {
        rasterReads: [
          raster(),
          raster({
            capture: {
              started: cursor(),
              completed: cursor({ revision: 11 }),
              sourceStable: true,
              rendererStable: true,
            },
          }),
        ],
      },
      'raster-bracket-tear',
    ],
    [
      'raster internal anchor vs A0',
      {
        rasterReads: [
          raster(),
          raster({
            capture: {
              started: cursor({ revision: 9 }),
              completed: cursor({ revision: 9 }),
              sourceStable: true,
              rendererStable: true,
            },
          }),
        ],
      },
      'raster-bracket-tear',
    ],
    [
      'raster source stability flag',
      {
        rasterReads: [
          raster(),
          raster({
            capture: {
              started: cursor(),
              completed: cursor(),
              sourceStable: false,
              rendererStable: true,
            },
          }),
        ],
      },
      'raster-bracket-tear',
    ],
    [
      'raster renderer stability flag',
      {
        rasterReads: [
          raster(),
          raster({
            capture: {
              started: cursor(),
              completed: cursor(),
              sourceStable: true,
              rendererStable: false,
            },
          }),
        ],
      },
      'raster-bracket-tear',
    ],
    [
      'raster target id',
      {
        rasterReads: [raster(), raster({ id: 'other-target' })],
      },
      'raster-bracket-tear',
    ],
    [
      'raster decoded width',
      {
        rasterReads: [
          raster(),
          raster({
            source: {
              sha256: 'src-a',
              byteLength: 8,
              mimeType: 'image/png',
              decodedWidth: 33,
              decodedHeight: 24,
            },
          }),
        ],
      },
      'raster-bracket-tear',
    ],
    [
      'raster byte length',
      {
        rasterReads: [
          raster(),
          raster({
            source: {
              sha256: 'src-a',
              byteLength: 9,
              mimeType: 'image/png',
              decodedWidth: 32,
              decodedHeight: 24,
            },
          }),
        ],
      },
      'raster-bracket-tear',
    ],
    [
      'raster alpha coverage',
      {
        rasterReads: [
          raster(),
          raster({
            rendered: {
              rgbaSha256: 'rgba-a',
              rgbaByteLength: 320 * 240 * 4,
              backingWidth: 320,
              backingHeight: 240,
              nonTransparentPixelCount: 320 * 240 - 1,
              drawnWidth: 320,
              drawnHeight: 240,
            },
          }),
        ],
      },
      'raster-bracket-tear',
    ],
    [
      'raster probe value',
      {
        rasterReads: [
          raster(),
          raster({
            rendered: {
              rgbaSha256: 'rgba-a',
              rgbaByteLength: 320 * 240 * 4,
              backingWidth: 320,
              backingHeight: 240,
              nonTransparentPixelCount: 320 * 240,
              drawnWidth: 320,
              drawnHeight: 240,
              probes: [
                {
                  probeSetId: 'rgba-probes-v1',
                  probeId: 'upper-left',
                  backingX: 20,
                  backingY: 20,
                  rgba: [9, 2, 3, 255],
                },
                {
                  probeSetId: 'rgba-probes-v1',
                  probeId: 'upper-right',
                  backingX: 220,
                  backingY: 20,
                  rgba: [4, 5, 6, 255],
                },
                {
                  probeSetId: 'rgba-probes-v1',
                  probeId: 'lower-left',
                  backingX: 20,
                  backingY: 180,
                  rgba: [7, 8, 9, 255],
                },
                {
                  probeSetId: 'rgba-probes-v1',
                  probeId: 'lower-right',
                  backingX: 220,
                  backingY: 180,
                  rgba: [10, 11, 12, 255],
                },
              ],
            },
          }),
        ],
      },
      'raster-bracket-tear',
    ],
    [
      'raster renderer generation',
      {
        rasterReads: [
          raster(),
          raster({
            renderer: {
              bridgeGeneration: 4,
              targetFingerprint: 'geom-1',
              target: { id: TARGET_ID },
            },
          }),
        ],
      },
      'raster-bracket-tear',
    ],
    [
      'raster renderer target',
      {
        rasterReads: [
          raster(),
          raster({
            renderer: {
              bridgeGeneration: 3,
              targetFingerprint: 'geom-1',
              target: { id: 'other-target' },
            },
          }),
        ],
      },
      'raster-bracket-tear',
    ],
    ['missing target', { targetIds: [TARGET_ID, 'missing-target'] }, 'target-missing'],
    [
      'unmounted target',
      { geometryReads: [geometry(), geometry({ mounted: false })] },
      'target-unmounted',
    ],
  ] as const)('tears on a one-field %s disagreement and receives no observationId', async (_name, options, reason) => {
    const allocate = vi.fn(() => 'must-not-be-allocated');
    const result = await captureCoherentObservation(
      makeDeps({
        ...(options as DepsOptions),
        now: () => 2_000,
        deadlineAt: 1_000,
        allocateObservationId: allocate,
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('OBSERVATION_TORN');
    expect(result.torn[0]?.reason).toBe(reason);
    expect(allocate).not.toHaveBeenCalled();
    expect((result as { observation?: unknown }).observation).toBeUndefined();
  });
});
