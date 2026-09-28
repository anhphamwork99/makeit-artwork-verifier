import { rmSync } from 'node:fs';

import { afterEach, describe, expect, it } from 'vitest';

import { allocateRun } from '../../src/allocation/allocate';
import { evidenceRootFor, expectedDistDirFor, scratchRootFor } from '../../src/allocation/lease';
import { releaseAllRunPortReservations } from '../../src/allocation/port-reservation';
import { closeBrowserSession, runDoctor } from '../../src/browser/doctor';
import type { BrowserSession } from '../../src/browser/launch';
import type { EnvironmentCell } from '../../src/contracts/runtime';
import { classifyOutcome } from '../../src/runtime/outcomes';
import { loadEnvironmentCatalogue, resolveEnvironmentCell } from '../../src/runtime/environment';
import { collectEnvironmentFacts } from '../../src/runtime/environment-facts';
import { uniqueRunId } from './helpers';

/**
 * Browser close failure blocks PASS (Gate D).
 *
 * A fresh Chromium context/browser that cannot be closed is an environment
 * cleanup failure with a structured diagnostic. It must never silently leak and
 * must never yield a PASS.
 */

const runIds: string[] = [];

afterEach(async () => {
  await releaseAllRunPortReservations();
  for (const runId of runIds.splice(0)) {
    rmSync(scratchRootFor(runId), { recursive: true, force: true });
    rmSync(expectedDistDirFor(runId), { recursive: true, force: true });
    rmSync(evidenceRootFor(runId), { recursive: true, force: true });
  }
});

function matchingPageFacts(cell: EnvironmentCell) {
  return {
    viewport: { ...cell.viewport },
    devicePixelRatio: cell.deviceScaleFactor,
    language: cell.locale,
    timezoneId: cell.timezoneId,
    colorScheme: cell.colorScheme,
    reducedMotion: cell.reducedMotion,
  };
}

function fakeSession(closeBehaviour: {
  contextCloseFails?: boolean;
  browserCloseFails?: boolean;
}): BrowserSession {
  const session = {
    browser: {
      close: async () => {
        if (closeBehaviour.browserCloseFails) throw new Error('browser close failed: injected');
      },
    },
    context: {
      close: async () => {
        if (closeBehaviour.contextCloseFails) throw new Error('context close failed: injected');
      },
    },
    page: {
      waitForFunction: async () => {},
      evaluate: async () => ({
        available: true,
        frozen: true,
        names: [
          'version',
          'doctor',
          'snapshot',
          'elements',
          'geometry',
          'raster',
          'cursor',
          'waitForChange',
          'waitForIdle',
        ],
        methods: [
          'doctor',
          'snapshot',
          'elements',
          'geometry',
          'raster',
          'cursor',
          'waitForChange',
          'waitForIdle',
        ],
        version: 7,
        doctor: {
          version: 7,
          observation: {
            schemaVersion: 1,
            documentId: 'doc-fixture',
            documentEpoch: 1_760_000_000_000,
            bridgeVersion: 7,
            bridgeGeneration: 1,
            revision: 0,
          },
          route: '/artwork/editor',
          document: {
            documentId: 'doc-fixture',
            documentEpoch: 1_760_000_000_000,
            bridgeVersion: 7,
          },
          stage: {
            mounted: true,
            width: 1440,
            height: 1000,
            layerNames: [
              'artwork-boards',
              'artwork-smart-guides',
              'artwork-warp-handles',
              'artwork-drag-overlay',
            ],
          },
          state: {
            rootCount: 1,
            scenegraphRootCount: 1,
            nodeCount: 4,
            layoutCount: 2,
            layerCount: 4,
            scenegraphInSync: true,
          },
        },
        cursorA: {
          schemaVersion: 1,
          documentId: 'doc-fixture',
          documentEpoch: 1_760_000_000_000,
          bridgeVersion: 7,
          bridgeGeneration: 1,
          revision: 0,
        },
        cursorB: {
          schemaVersion: 1,
          documentId: 'doc-fixture',
          documentEpoch: 1_760_000_000_000,
          bridgeVersion: 7,
          bridgeGeneration: 1,
          revision: 0,
        },
        waiter: { status: 'timeout' },
        rasterProbe: {
          id: 'layout-1',
          isPromise: true,
          schemaVersion: 3,
          status: 'not-applicable',
          hasObservation: true,
        },
      }),
      title: async () => 'Editor - Artwork',
      url: () => 'http://127.0.0.1:1/artwork/editor',
      screenshot: async () => {},
    },
    consoleErrors: [],
    failedRequests: [],
    responseStatus: 200,
  };
  return session as unknown as BrowserSession;
}

describe('[Gate D] browser close failure', () => {
  it('reports a structured failure when the fresh context cannot be closed', async () => {
    const outcome = await closeBrowserSession(fakeSession({ contextCloseFails: true }));
    expect(outcome.closed).toBe(false);
    expect(outcome.detail).toContain('context close failed: injected');
  });

  it('reports a structured failure when the browser cannot be closed', async () => {
    const outcome = await closeBrowserSession(fakeSession({ browserCloseFails: true }));
    expect(outcome.closed).toBe(false);
    expect(outcome.detail).toContain('browser close failed: injected');
  });

  it('reports success when both the context and browser close', async () => {
    const outcome = await closeBrowserSession(fakeSession({}));
    expect(outcome).toEqual({ closed: true, detail: null });
  });

  it('classifies a Doctor browser-close failure as ENVIRONMENT_FAILURE, never PASS', async () => {
    const runId = uniqueRunId('vt-browser');
    runIds.push(runId);
    const allocation = await allocateRun({ runId });
    if (!allocation.ok) throw new Error('fixture allocation failed');

    const environment = resolveEnvironmentCell(
      loadEnvironmentCatalogue(),
      allocation.allocation.environmentCellId,
    );
    const doctorRun = await runDoctor({
      allocation: allocation.allocation,
      environment,
      environmentFacts: collectEnvironmentFacts({
        cell: environment,
        baseUrl: allocation.allocation.baseUrl,
        chromiumExecutablePath: process.execPath,
      }),
      registry: { schemaVersion: null, fingerprint: null, resolvedSubjects: null },
      appRevision: { commit: null, dirty: null },
      openPage: async () => fakeSession({ browserCloseFails: true }),
      observeEnvironment: async () => matchingPageFacts(environment),
    });

    expect(doctorRun.browserCloseError).toContain('browser close failed: injected');
    expect(doctorRun.environmentInvalid).toBe(true);
    expect(doctorRun.behaviorOutcome).toBe('ENVIRONMENT_FAILURE');
    expect(doctorRun.result.outcome).toBe('ENVIRONMENT_FAILURE');
    expect(doctorRun.result.diagnostics.map((entry) => entry.code)).toContain(
      'BROWSER_CLEANUP_FAILED',
    );

    // All behavior checks can pass and the result still cannot be PASS.
    const outcome = classifyOutcome({
      requiredChecks: doctorRun.requiredChecks,
      cleanupSucceeded: false,
      environmentInvalid: doctorRun.environmentInvalid,
    });
    expect(doctorRun.requiredChecks.every((check) => check.passed)).toBe(true);
    expect(outcome).toBe('ENVIRONMENT_FAILURE');
  }, 30_000);
});
