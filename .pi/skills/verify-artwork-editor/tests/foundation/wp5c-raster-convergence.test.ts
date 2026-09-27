import { describe, expect, it, vi } from 'vitest';

import type { ObservationCursor, WaitForChangeOutcome } from '../../src/contracts/observation';
import { createDiagnostic } from '../../src/contracts/diagnostics';
import { loadResourceManifest } from '../../src/catalogue/resources';
import type { ResourceManifestEntry } from '../../src/contracts/resources';
import {
  awaitExpectedRasterConvergence,
  evaluateExpectedRasterCurrentness,
  type RasterConvergenceDeps,
} from '../../src/readiness/raster-currentness';
import type { ImageRasterRecordView, RasterProbeResultView } from '../../src/contracts/raster';
import type { RasterBracketView } from '../../src/readiness/coherent-capture';
import { IMAGE_RASTER_ACTION_CYCLE_PROFILE } from '../../src/readiness/correlated-gate';

/**
 * Supervisor R13 required test 38 — `source B with temporary non-B probes
 * remains non-converged rather than receiving a premature Oracle BUG`.
 *
 * Proves the R6 signal-first expected-raster convergence loop: a well-formed but
 * stale A canvas after the B semantic transition is a *non-converged readiness
 * candidate* that is re-read inside the same non-extending deadline, converges
 * when B lands, and becomes a terminal product BUG only when the deadline
 * elapses without convergence. No observation id and no Oracle input exist for a
 * non-converged candidate.
 */

const manifest = loadResourceManifest();
const A = manifest.resources.find(
  (entry) => entry.logicalId === 'image.upload-a',
) as ResourceManifestEntry;
const B = manifest.resources.find(
  (entry) => entry.logicalId === 'image.upload-b',
) as ResourceManifestEntry;
const TARGET_ID = 'layout-image-a-image-1';

const EXPECTED_FRAME = { x: 90, y: 110, width: 320, height: 240, rotation: 0 };

function cursor(revision: number): ObservationCursor {
  return {
    schemaVersion: 1,
    documentId: 'doc',
    documentEpoch: 1,
    bridgeVersion: 5,
    bridgeGeneration: 1,
    revision,
  };
}

function expectedResource(entry: ResourceManifestEntry) {
  return {
    sha256: entry.sha256,
    byteLength: entry.byteLength,
    mimeType: entry.mimeType,
    dimensions: entry.dimensions,
    probes: entry.structuralVisual.probes.map((probe) => ({
      id: probe.id,
      x: probe.x,
      y: probe.y,
      expectedRgba: probe.expectedRgba,
      channelTolerance: probe.channelTolerance,
    })),
  };
}

function rasterRecord(
  entry: ResourceManifestEntry,
  overrides: { rgbaSha?: string; revision?: number } = {},
): ImageRasterRecordView {
  const backingWidth = 320;
  const backingHeight = 240;
  const revision = overrides.revision ?? 5;
  const probes: RasterProbeResultView[] = entry.structuralVisual.probes.map((probe) => ({
    probeSetId: 'rgba-probes-v1',
    probeId: probe.id,
    x: probe.x,
    y: probe.y,
    backingX: Math.min(
      backingWidth - 1,
      Math.floor((backingWidth * probe.x.numerator) / probe.x.denominator),
    ),
    backingY: Math.min(
      backingHeight - 1,
      Math.floor((backingHeight * probe.y.numerator) / probe.y.denominator),
    ),
    rgba: probe.expectedRgba,
  }));
  return {
    rasterSchemaVersion: 3,
    authorityKind: 'image-source-v2',
    observation: cursor(revision),
    id: TARGET_ID,
    kind: 'image',
    mounted: true,
    status: 'ready',
    source: {
      scheme: 'blob',
      sha256: entry.sha256,
      byteLength: entry.byteLength,
      mimeType: entry.mimeType,
      decodedWidth: entry.dimensions.width,
      decodedHeight: entry.dimensions.height,
      sourceFingerprint: `source-${entry.logicalId}`,
    },
    rendered: {
      nodeClass: 'Image',
      rgbaSha256: overrides.rgbaSha ?? `rgba-${entry.logicalId}`,
      rgbaByteLength: backingWidth * backingHeight * 4,
      backingWidth,
      backingHeight,
      nonTransparentPixelCount: backingWidth * backingHeight,
      drawnWidth: backingWidth,
      drawnHeight: backingHeight,
      probes,
    },
    renderer: {
      bridgeGeneration: 1,
      stageFingerprint: 'stage',
      targetFingerprint: 'geom',
      target: { id: TARGET_ID },
    },
    capture: {
      started: cursor(revision),
      completed: cursor(revision),
      sourceStable: true,
      rendererStable: true,
    },
    rasterFingerprint: `rf-${entry.logicalId}`,
  };
}

function evaluate(view: RasterBracketView) {
  return () =>
    evaluateExpectedRasterCurrentness({
      raster: view,
      targetId: TARGET_ID,
      expectedResource: expectedResource(B),
      expectedFrame: EXPECTED_FRAME,
      mode: 'replacement',
      acceptedUpload: {
        sourceSha256: A.sha256,
        rgbaSha256: `rgba-${A.logicalId}`,
        probes: [],
      },
    });
}

function makeClock(start = 0) {
  let value = start;
  return {
    now: () => value,
    advance: (ms: number) => {
      value += ms;
      return value;
    },
  };
}

describe('test 37/38 — expected-raster convergence and deadline BUG classification', () => {
  it('treats a stale A canvas after B as a well-formed non-converged candidate, not a BUG', () => {
    const stale = evaluate(rasterRecord(A))();
    expect(stale.status).toBe('mismatch');
    expect(stale.diagnostic).toBeNull();
    expect(stale.mismatchedFields).toContain('source.sha256');
    expect(stale.mismatchedFields).toContain('rendered.rgbaSha256===acceptedA');
    expect(stale.detail).toContain('has not converged');
  });

  it('treats a malformed raster record as unusable authority, never a product mismatch', () => {
    const malformed = evaluate({ ...rasterRecord(A), rasterSchemaVersion: 1 } as never)();
    expect(malformed.status).toBe('unusable');
    expect(malformed.diagnostic?.code).toBe('RASTER_SCHEMA_UNSUPPORTED');
  });

  it('converges temporary stale A → B inside one non-extending deadline with no premature BUG', async () => {
    const reads: RasterBracketView[] = [rasterRecord(A), rasterRecord(A), rasterRecord(B)];
    let readIndex = 0;
    const clock = makeClock();
    const waits: number[] = [];
    const sleepSpy = vi.fn(async (ms: number) => {
      clock.advance(ms);
    });
    const deps: RasterConvergenceDeps = {
      profile: IMAGE_RASTER_ACTION_CYCLE_PROFILE,
      now: clock.now,
      deadlineAt: 8_000,
      armCursor: cursor(5),
      waitForChange: async (_after, timeoutMs) => {
        waits.push(timeoutMs);
        clock.advance(Math.min(timeoutMs, 100));
        return {
          status: 'timeout',
          cursor: null,
          waitedMs: Math.min(timeoutMs, 100),
        } as WaitForChangeOutcome;
      },
      readCursor: async () => cursor(5),
      readRaster: async () => reads[Math.min(readIndex++, reads.length - 1)] as RasterBracketView,
      evaluate: (view) => evaluate(view)(),
      sleep: sleepSpy,
    };

    const result = await awaitExpectedRasterConvergence(deps);
    expect(result.status).toBe('converged');
    if (result.status !== 'converged') return;
    expect(result.attempts).toBe(3);
    expect(result.mismatches).toHaveLength(2);
    expect(result.mismatches.every((detail) => detail.includes('has not converged'))).toBe(true);
    expect((result.raster.source as { sha256: string }).sha256).toBe(B.sha256);
    // Readiness never produces an observation: only an accepted coherent
    // capture receives an observationId and reaches the Oracle.
    expect('observationId' in result).toBe(false);
    // Every read happened inside the one 8,000 ms deadline.
    expect(clock.now()).toBeLessThanOrEqual(8_000);
  });

  it('classifies permanent stale A as the terminal deadline non-convergence (BUG), not torn/unusable', async () => {
    const clock = makeClock();
    const deps: RasterConvergenceDeps = {
      profile: IMAGE_RASTER_ACTION_CYCLE_PROFILE,
      now: clock.now,
      deadlineAt: 400,
      armCursor: cursor(5),
      waitForChange: async (_after, timeoutMs) => {
        clock.advance(Math.max(1, Math.min(timeoutMs, 100)));
        return { status: 'timeout', cursor: null, waitedMs: timeoutMs } as WaitForChangeOutcome;
      },
      readCursor: async () => cursor(5),
      readRaster: async () => rasterRecord(A),
      evaluate: (view) => evaluate(view)(),
      sleep: async (ms: number) => {
        clock.advance(ms);
      },
    };

    const result = await awaitExpectedRasterConvergence(deps);
    expect(result.status).toBe('deadline-exceeded');
    if (result.status !== 'deadline-exceeded') return;
    expect(result.mismatches.length).toBeGreaterThanOrEqual(1);
    expect(result.lastDetail).toContain('has not converged');
    expect(clock.now()).toBeGreaterThanOrEqual(400);
    // The non-converged candidate never receives an observation id.
    expect('observationId' in result).toBe(false);
  });

  it('reports the actual loop counters on an unusable exit instead of defaulting them to zero', async () => {
    const clock = makeClock();
    let reads = 0;
    const deps: RasterConvergenceDeps = {
      profile: IMAGE_RASTER_ACTION_CYCLE_PROFILE,
      now: clock.now,
      deadlineAt: 8_000,
      armCursor: cursor(5),
      waitForChange: async (_after, timeoutMs) => {
        clock.advance(Math.min(timeoutMs, 50));
        return {
          status: 'timeout',
          cursor: null,
          waitedMs: Math.min(timeoutMs, 50),
        } as WaitForChangeOutcome;
      },
      readCursor: async () => cursor(6),
      readRaster: async () => rasterRecord(A),
      evaluate: () => {
        reads += 1;
        return reads <= 2
          ? {
              status: 'mismatch',
              detail: 'stale A',
              mismatchedFields: ['source.sha256'],
              diagnostic: null,
            }
          : {
              status: 'unusable',
              detail: 'The captured raster authority was unusable.',
              mismatchedFields: [],
              diagnostic: createDiagnostic(
                'RASTER_AUTHORITY_UNUSABLE',
                'The captured raster authority was unusable.',
              ),
            };
      },
      sleep: async (ms: number) => {
        clock.advance(ms);
      },
    };

    const result = await awaitExpectedRasterConvergence(deps);
    expect(result.status).toBe('unusable');
    if (result.status !== 'unusable') return;
    // The observed loop state is reported: one signal watchdog, one bounded
    // fallback poll, and the poll wake source — never defaulted zeros.
    expect(result.attempts).toBe(3);
    expect(result.watchdogWaits).toBe(1);
    expect(result.fallbackPollCount).toBe(1);
    expect(result.wakeSource).toBe('poll-fallback');
    expect(result.mismatches).toHaveLength(2);
    expect(result.diagnostic?.code).toBe('RASTER_AUTHORITY_UNUSABLE');
    expect(clock.now()).toBeLessThanOrEqual(8_000);
  });

  it('stays signal-first without a fixed sleep when the store signal wakes convergence', async () => {
    const reads: RasterBracketView[] = [rasterRecord(A), rasterRecord(B)];
    let readIndex = 0;
    const clock = makeClock();
    const sleepSpy = vi.fn(async () => {});
    const deps: RasterConvergenceDeps = {
      profile: IMAGE_RASTER_ACTION_CYCLE_PROFILE,
      now: clock.now,
      deadlineAt: 8_000,
      armCursor: cursor(5),
      waitForChange: async () => {
        clock.advance(10);
        return {
          status: 'changed',
          cursor: cursor(6),
          wakeSource: 'store-signal',
          waitedMs: 10,
        } as WaitForChangeOutcome;
      },
      readCursor: async () => cursor(6),
      readRaster: async () => reads[Math.min(readIndex++, reads.length - 1)] as RasterBracketView,
      evaluate: (view) => evaluate(view)(),
      sleep: sleepSpy,
    };

    const result = await awaitExpectedRasterConvergence(deps);
    expect(result.status).toBe('converged');
    if (result.status !== 'converged') return;
    expect(result.attempts).toBe(2);
    expect(result.wakeSource).toBe('store-signal');
    expect(result.fallbackPollCount).toBe(0);
    // Signal-first: the first read is immediate; no cadence sleep is used.
    expect(sleepSpy).not.toHaveBeenCalled();
    expect(clock.now()).toBe(10);
  });
});
