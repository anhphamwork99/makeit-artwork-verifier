import { describe, expect, it } from 'vitest';

import type { ObservationCursor } from '../../src/contracts/observation';
import {
  runActionCycle,
  type ActionCycleDeps,
  type ActionDispatchResult,
} from '../../src/runtime/action-cycle';
import type { ReadinessProfile } from '../../src/readiness/correlated-gate';
import type {
  StampedGeometryView,
  StampedSnapshotView,
} from '../../src/readiness/coherent-capture';

/**
 * WP5 Slice 5-A action-cycle classification tests (TS-1 foundation).
 *
 * The action cycle is the one place where a trustworthy action plus accepted
 * authority is converted into `PASS`/`BUG`/`HARNESS_BLOCKED`. These tests use
 * injected bridge reads and a deterministic clock so every terminal branch is
 * exercised without a browser.
 */

const TARGET = 'layer-1';

function cursor(revision: number, overrides: Partial<ObservationCursor> = {}): ObservationCursor {
  return {
    schemaVersion: 1,
    documentId: 'doc-1',
    documentEpoch: 1,
    bridgeVersion: 5,
    bridgeGeneration: 4,
    revision,
    ...overrides,
  };
}

function layout(x: number, y: number): unknown {
  return [
    {
      id: 'layout-a',
      xCoordinate: 0,
      yCoordinate: 0,
      layers: [{ id: TARGET, xCoordinate: x, yCoordinate: y }],
    },
  ];
}

function snapshot(revision: number, x: number, y: number): StampedSnapshotView {
  return { observation: cursor(revision), layoutItems: layout(x, y) };
}

function rendererFingerprint(x: number, y: number, id = TARGET): string {
  return JSON.stringify({ id, x, y });
}

function geometry(
  revision: number,
  x: number,
  y: number,
  targetFingerprint = rendererFingerprint(x, y),
): StampedGeometryView {
  return {
    observation: cursor(revision),
    id: TARGET,
    mounted: true,
    visible: true,
    listening: true,
    sceneRect: { x, y, width: 100, height: 40 },
    viewportRect: { x, y, width: 100, height: 40 },
    hitPoint: { x: x + 50, y: y + 20 },
    renderer: {
      bridgeGeneration: 4,
      stageFingerprint: 'stage-a',
      targetFingerprint,
      target: { id: TARGET, nodeClass: 'Group', x, y },
    },
  };
}

interface HarnessOptions {
  moved: boolean;
  minimumDelta: { x: number; y: number };
  signal?: 'store-signal' | 'invalidated' | 'never';
  tearGeometryRevision?: number;
  actionRefused?: boolean;
  deadlineMs?: number;
}

function makeHarness(options: HarnessOptions): {
  deps: ActionCycleDeps;
  action: () => ActionDispatchResult;
} {
  let t = 0;
  const profile: ReadinessProfile = {
    schemaVersion: 1,
    profileId: 'test-action-cycle',
    timingCategory: 'INTERACTIVE_RENDER_V1',
    deadlineMs: options.deadlineMs ?? 5_000,
    signalWatchdogMs: 50,
    fallbackCadenceMs: [50, 100, 125],
    stableFrames: 3,
  };
  const signal = options.signal ?? 'store-signal';
  const afterRevision = options.moved ? 6 : 5;

  const deps: ActionCycleDeps = {
    profile,
    now: () => t,
    targetIds: [TARGET],
    requiredChecks: ['geometry.delta'],
    minimumDelta: options.minimumDelta,
    baseline: {
      cursor: cursor(5),
      snapshot: snapshot(5, 125, 125),
      geometry: { [TARGET]: geometry(5, 125, 125) },
    },
    readCursor: async () => cursor(afterRevision),
    readSnapshot: async () => {
      t += 3_000;
      return snapshot(afterRevision, options.moved ? 205 : 125, options.moved ? 165 : 125);
    },
    readGeometry: async () =>
      options.tearGeometryRevision === undefined
        ? geometry(afterRevision, options.moved ? 205 : 125, options.moved ? 165 : 125)
        : geometry(
            options.tearGeometryRevision,
            options.moved ? 205 : 125,
            options.moved ? 165 : 125,
          ),
    waitForChange: async (after, timeoutMs) => {
      if (signal === 'invalidated') {
        return { status: 'invalidated', cursor: null, reason: 'bridge-unmounted', waitedMs: 0 };
      }
      if (signal === 'store-signal' && options.moved) {
        return {
          status: 'changed',
          cursor: cursor(afterRevision),
          wakeSource: 'store-signal',
          waitedMs: 0,
        };
      }
      t += timeoutMs;
      return { status: 'timeout', cursor: after, waitedMs: timeoutMs };
    },
    waitForIdle: async () => ({
      observation: cursor(afterRevision),
      snapshot: snapshot(afterRevision, options.moved ? 205 : 125, options.moved ? 165 : 125),
      renderer: {
        bridgeGeneration: 4,
        stageFingerprint: 'stage-a',
        targets: [
          {
            id: TARGET,
            fingerprint: rendererFingerprint(options.moved ? 205 : 125, options.moved ? 165 : 125),
            mounted: true,
            visible: true,
            listening: true,
          },
        ],
      },
    }),
    evaluateCausalTransition: async () => {
      const moved = options.moved;
      return { satisfied: moved, detail: moved ? 'moved' : 'no required transition' };
    },
    performAction: async () => actionResult,
    sleep: async (ms) => {
      t += ms;
    },
  };

  const actionResult: ActionDispatchResult = options.actionRefused
    ? { ok: false, detail: 'hit point refused', code: 'HIT_POINT_UNAVAILABLE', at: 'now' }
    : { ok: true, detail: 'dragged', at: 'now' };

  return { deps, action: () => actionResult };
}

describe('[TS-1] action-cycle terminal classification', () => {
  it('reaches PASS with a signal-first wake and zero fallback polls', async () => {
    const { deps } = makeHarness({ moved: true, minimumDelta: { x: 40, y: 20 } });
    const result = await runActionCycle(deps);
    expect(result.behaviorOutcome).toBe('PASS');
    expect(result.wakeSource).toBe('store-signal');
    expect(result.fallbackPollCount).toBe(0);
    expect(result.observation?.observationId).toBeTruthy();
    expect(result.requiredChecks).toEqual([{ checkId: 'geometry.delta', passed: true }]);
  });

  it('reports BUG for an impossible required delta after the same real action', async () => {
    const { deps } = makeHarness({ moved: true, minimumDelta: { x: 500, y: 500 } });
    const result = await runActionCycle(deps);
    expect(result.behaviorOutcome).toBe('BUG');
    expect(result.harnessInvalid).toBe(false);
    expect(result.requiredChecks).toEqual([{ checkId: 'geometry.delta', passed: false }]);
  });

  it('reports BUG when no required causal transition is observed by the deadline', async () => {
    const { deps } = makeHarness({
      moved: false,
      minimumDelta: { x: 40, y: 20 },
      signal: 'never',
      deadlineMs: 300,
    });
    const result = await runActionCycle(deps);
    expect(result.behaviorOutcome).toBe('BUG');
    expect(result.harnessInvalid).toBe(false);
    expect(result.gate?.status).toBe('deadline-exceeded');
  });

  it('reports HARNESS_BLOCKED when observation authority is invalidated', async () => {
    const { deps } = makeHarness({
      moved: true,
      minimumDelta: { x: 40, y: 20 },
      signal: 'invalidated',
    });
    const result = await runActionCycle(deps);
    expect(result.behaviorOutcome).toBe('HARNESS_BLOCKED');
    expect(result.harnessInvalid).toBe(true);
    expect(result.diagnostics.map((entry) => entry.code)).toContain('UNUSABLE_EVIDENCE');
  });

  it('reports HARNESS_BLOCKED when the native action is refused before dispatch', async () => {
    const { deps } = makeHarness({
      moved: true,
      minimumDelta: { x: 40, y: 20 },
      actionRefused: true,
    });
    const result = await runActionCycle(deps);
    expect(result.behaviorOutcome).toBe('HARNESS_BLOCKED');
    expect(result.diagnostics.map((entry) => entry.code)).toContain('HIT_POINT_UNAVAILABLE');
    expect(result.observation).toBeNull();
  });

  it('reports HARNESS_BLOCKED for a torn capture and never hands it to the Oracle', async () => {
    const { deps } = makeHarness({
      moved: true,
      minimumDelta: { x: 40, y: 20 },
      tearGeometryRevision: 7,
    });
    const result = await runActionCycle(deps);
    expect(result.behaviorOutcome).toBe('HARNESS_BLOCKED');
    expect(result.observation).toBeNull();
    expect(result.oracle).toBeNull();
    expect(result.diagnostics.map((entry) => entry.code)).toContain('OBSERVATION_TORN');
    expect(result.torn.length).toBeGreaterThan(0);
  });
});
