import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { allocateRun } from '../../src/allocation/allocate';
import { evidenceRootFor, expectedDistDirFor, scratchRootFor } from '../../src/allocation/lease';
import { releaseAllRunPortReservations } from '../../src/allocation/port-reservation';
import { EXPECTED_BRIDGE_VERSION, runDoctor, type DoctorRunResult } from '../../src/browser/doctor';
import type { BrowserSession } from '../../src/browser/launch';
import type {
  EnvironmentCell,
  ObservedEnvironmentFacts,
  RunAllocation,
} from '../../src/contracts/runtime';
import { DOCTOR_RESULT_SCHEMA_VERSION } from '../../src/contracts/schema-versions';
import { loadEnvironmentCatalogue, resolveEnvironmentCell } from '../../src/runtime/environment';
import { collectEnvironmentFacts } from '../../src/runtime/environment-facts';
import { resolveRepoRoot, resolveToolkitRoot } from '../../src/runtime/paths';
import { uniqueRunId } from './helpers';

/**
 * Doctor v6 evidence contract for observation bridge v6 (TS-3, Gate C;
 * specification 10, 17; WP5 Slice 5-A/C).
 *
 * Doctor must independently inspect the live bridge object — the exact frozen
 * eight-method surface, the document-correlated cursor, and a bounded waiter —
 * and must keep the known `layoutItems` versus `nodes/rootIds` discrepancy
 * visible without repairing it or treating the stale mirror as rendered truth.
 */

const runIds: string[] = [];

const READ_ONLY_METHODS = [
  'doctor',
  'snapshot',
  'elements',
  'geometry',
  'raster',
  'cursor',
  'waitForChange',
  'waitForIdle',
];

afterEach(async () => {
  await releaseAllRunPortReservations();
  for (const runId of runIds.splice(0)) {
    rmSync(scratchRootFor(runId), { recursive: true, force: true });
    rmSync(expectedDistDirFor(runId), { recursive: true, force: true });
    rmSync(evidenceRootFor(runId), { recursive: true, force: true });
  }
});

function fakeSession(payload: unknown): BrowserSession {
  return {
    browser: { close: async () => {} },
    context: { close: async () => {} },
    page: {
      waitForFunction: async () => {},
      evaluate: async () => payload,
      title: async () => 'Editor - Artwork',
      url: () => 'http://127.0.0.1:1/artwork/editor',
      screenshot: async () => {},
    },
    consoleErrors: [],
    failedRequests: [],
    responseStatus: 200,
  } as unknown as BrowserSession;
}

const stage = {
  mounted: true,
  width: 1440,
  height: 1000,
  layerNames: [
    'artwork-boards',
    'artwork-smart-guides',
    'artwork-warp-handles',
    'artwork-drag-overlay',
  ],
};

function cursorFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    documentId: 'doc-7f3c',
    documentEpoch: 1_760_000_000_123,
    bridgeVersion: 7,
    bridgeGeneration: 1,
    revision: 0,
    ...overrides,
  };
}

/** A v7 inspection payload that a conforming bridge would produce. */
function v3Inspection(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const cursor = cursorFixture();
  return {
    available: true,
    frozen: true,
    names: ['version', ...READ_ONLY_METHODS],
    methods: [...READ_ONLY_METHODS],
    version: 7,
    doctor: {
      version: 7,
      observation: cursor,
      methods: [...READ_ONLY_METHODS],
      route: '/artwork/editor',
      document: { documentId: 'doc-7f3c', documentEpoch: 1_760_000_000_123, bridgeVersion: 7 },
      stage,
      state: {
        rootCount: 2,
        scenegraphRootCount: 2,
        nodeCount: 2,
        layoutCount: 2,
        layerCount: 0,
        scenegraphInSync: true,
      },
    },
    cursorA: cursor,
    cursorB: cursor,
    waiter: { status: 'timeout' },
    rasterProbe: {
      id: 'layout-1',
      isPromise: true,
      schemaVersion: 3,
      status: 'not-applicable',
      hasObservation: true,
    },
    ...overrides,
  };
}

/** Facts a page that agrees with the governed cell would report. */
function matchingPageFacts(cell: EnvironmentCell): ObservedEnvironmentFacts {
  return {
    viewport: { ...cell.viewport },
    devicePixelRatio: cell.deviceScaleFactor,
    language: cell.locale,
    timezoneId: cell.timezoneId,
    colorScheme: cell.colorScheme,
    reducedMotion: cell.reducedMotion,
  };
}

async function runDoctorWithBridge(
  payload: unknown,
  options: { observedEnvironment?: ObservedEnvironmentFacts } = {},
): Promise<{ run: DoctorRunResult; allocation: RunAllocation; cell: EnvironmentCell }> {
  const runId = uniqueRunId('vt-bridge');
  runIds.push(runId);
  const allocation = await allocateRun({ runId });
  if (!allocation.ok) throw new Error('fixture allocation failed');

  const environment = resolveEnvironmentCell(
    loadEnvironmentCatalogue(),
    allocation.allocation.environmentCellId,
  );
  const run = await runDoctor({
    allocation: allocation.allocation,
    environment,
    environmentFacts: collectEnvironmentFacts({
      cell: environment,
      baseUrl: allocation.allocation.baseUrl,
      chromiumExecutablePath: process.execPath,
    }),
    registry: { schemaVersion: null, fingerprint: null, resolvedSubjects: null },
    appRevision: { commit: null, dirty: null },
    openPage: async () => fakeSession(payload),
    observeEnvironment: async () => options.observedEnvironment ?? matchingPageFacts(environment),
  });
  return { run, allocation: allocation.allocation, cell: environment };
}

function checkPassed(run: DoctorRunResult, checkId: string): boolean {
  const check = run.requiredChecks.find((entry) => entry.checkId === checkId);
  if (!check) throw new Error(`missing required check ${checkId}`);
  return check.passed;
}

function diagnosticsCodes(run: DoctorRunResult): string[] {
  return run.result.diagnostics.map((entry) => entry.code);
}

describe('[TS-3] Doctor inspects the observation bridge v7 contract', () => {
  it('expects bridge contract version 7 and Doctor schema 7', () => {
    expect(EXPECTED_BRIDGE_VERSION).toBe(7);
    expect(DOCTOR_RESULT_SCHEMA_VERSION).toBe(7);
  });

  it('independently records the frozen method surface, cursor, and identity', async () => {
    const { run, allocation } = await runDoctorWithBridge(v3Inspection());

    expect(run.harnessInvalid).toBe(false);
    expect(run.behaviorOutcome).toBe('PASS');
    expect(checkPassed(run, 'doctor.bridge.version')).toBe(true);
    expect(checkPassed(run, 'doctor.bridge.document')).toBe(true);
    expect(checkPassed(run, 'doctor.bridge.methods')).toBe(true);
    expect(checkPassed(run, 'doctor.bridge.frozen')).toBe(true);
    expect(checkPassed(run, 'doctor.bridge.cursor')).toBe(true);
    expect(checkPassed(run, 'doctor.bridge.cursor-stable')).toBe(true);
    expect(checkPassed(run, 'doctor.bridge.waiter')).toBe(true);
    expect(checkPassed(run, 'doctor.state.scenegraph')).toBe(true);

    expect(run.result.bridge).toEqual(
      expect.objectContaining({
        expectedVersion: 7,
        observedVersion: 7,
        documentId: 'doc-7f3c',
        documentEpoch: 1_760_000_000_123,
        frozen: true,
        bridgeGeneration: 1,
        revision: 0,
        cursorSchemaVersion: 1,
        cursorStable: true,
        waiterBounded: true,
      }),
    );
    expect([...run.result.bridge.methods].sort()).toEqual([...READ_ONLY_METHODS].sort());

    const written = JSON.parse(
      readFileSync(path.join(allocation.scratchRoot, 'candidates', 'doctor.json'), 'utf8'),
    ) as {
      schemaVersion: number;
      outcome: string;
      bridge: Record<string, unknown>;
    };
    expect(written.schemaVersion).toBe(7);
    expect(written.outcome).toBe('PASS');
    expect(written.bridge.documentId).toBe('doc-7f3c');
    expect(written.bridge.cursorSchemaVersion).toBe(1);
  });

  it('fails closed on a mixed v6 bridge because the version no longer matches', async () => {
    const legacyCursor = cursorFixture({ bridgeVersion: 6 });
    const { run } = await runDoctorWithBridge(
      v3Inspection({
        version: 6,
        doctor: {
          version: 6,
          observation: legacyCursor,
          methods: [...READ_ONLY_METHODS],
          route: '/artwork/editor',
          document: {
            documentId: 'doc-7f3c',
            documentEpoch: 1_760_000_000_123,
            bridgeVersion: 6,
          },
          stage,
          state: {
            rootCount: 2,
            scenegraphRootCount: 2,
            nodeCount: 2,
            layoutCount: 2,
            layerCount: 0,
            scenegraphInSync: true,
          },
        },
        cursorA: legacyCursor,
        cursorB: legacyCursor,
      }),
    );

    expect(run.harnessInvalid).toBe(true);
    expect(run.behaviorOutcome).toBe('HARNESS_BLOCKED');
    expect(checkPassed(run, 'doctor.bridge.version')).toBe(false);
    expect(diagnosticsCodes(run)).toContain('BRIDGE_VERSION_MISMATCH');
  });

  it('fails closed on method drift or an unfrozen bridge', async () => {
    const drift = await runDoctorWithBridge(
      v3Inspection({ methods: [...READ_ONLY_METHODS, 'drive'], names: ['version', 'drive'] }),
    );
    expect(drift.run.harnessInvalid).toBe(true);
    expect(checkPassed(drift.run, 'doctor.bridge.methods')).toBe(false);

    const unfrozen = await runDoctorWithBridge(v3Inspection({ frozen: false }));
    expect(unfrozen.run.harnessInvalid).toBe(true);
    expect(checkPassed(unfrozen.run, 'doctor.bridge.frozen')).toBe(false);
  });

  it('fails closed on a malformed, unstable, or identity-mismatched cursor', async () => {
    const malformed = await runDoctorWithBridge(
      v3Inspection({ cursorA: cursorFixture({ schemaVersion: 2 }) }),
    );
    expect(malformed.run.harnessInvalid).toBe(true);
    expect(checkPassed(malformed.run, 'doctor.bridge.cursor')).toBe(false);

    const unstable = await runDoctorWithBridge(
      v3Inspection({ cursorB: cursorFixture({ revision: 4 }) }),
    );
    expect(unstable.run.harnessInvalid).toBe(true);
    expect(checkPassed(unstable.run, 'doctor.bridge.cursor-stable')).toBe(false);

    const mismatched = await runDoctorWithBridge(
      v3Inspection({ cursorA: cursorFixture({ documentId: 'doc-other' }) }),
    );
    expect(mismatched.run.harnessInvalid).toBe(true);
    expect(checkPassed(mismatched.run, 'doctor.bridge.cursor')).toBe(false);
  });

  it('reports distinct geometry and mutation failures instead of a blanket version mismatch', async () => {
    const geometrySchema = await runDoctorWithBridge(
      v3Inspection({
        geometryProbe: {
          id: 'layer-a-text-1',
          hasGeometryV2: true,
          schemaVersion: 1,
          targetId: 'layer-a-text-1',
          layoutId: 'layout-a',
          mounted: true,
        },
      }),
    );
    expect(geometrySchema.run.harnessInvalid).toBe(true);
    expect(geometrySchema.run.behaviorOutcome).toBe('HARNESS_BLOCKED');
    expect(checkPassed(geometrySchema.run, 'doctor.bridge.geometry')).toBe(false);
    expect(diagnosticsCodes(geometrySchema.run)).toContain('GEOMETRY_REPRESENTATION_UNSUPPORTED');
    expect(diagnosticsCodes(geometrySchema.run)).not.toContain('BRIDGE_VERSION_MISMATCH');

    const geometryTarget = await runDoctorWithBridge(
      v3Inspection({
        geometryProbe: {
          id: 'layer-a-text-1',
          hasGeometryV2: true,
          schemaVersion: 2,
          targetId: 'layer-a-text-1',
          layoutId: 'layout-a',
          mounted: false,
        },
      }),
    );
    expect(checkPassed(geometryTarget.run, 'doctor.bridge.geometry')).toBe(false);
    expect(diagnosticsCodes(geometryTarget.run)).toContain('GEOMETRY_TARGET_ID_MISMATCH');
    expect(diagnosticsCodes(geometryTarget.run)).not.toContain('BRIDGE_VERSION_MISMATCH');

    const mutation = await runDoctorWithBridge(v3Inspection({ mutationDetected: true }));
    expect(mutation.run.harnessInvalid).toBe(true);
    expect(checkPassed(mutation.run, 'doctor.bridge.no-mutation')).toBe(false);
    expect(diagnosticsCodes(mutation.run)).toContain('BRIDGE_MUTATION_DETECTED');
    expect(diagnosticsCodes(mutation.run)).not.toContain('BRIDGE_VERSION_MISMATCH');
  });

  it('fails closed when the zero-timeout waiter is not bounded', async () => {
    const { run } = await runDoctorWithBridge(v3Inspection({ waiter: { status: 'changed' } }));
    expect(run.harnessInvalid).toBe(true);
    expect(checkPassed(run, 'doctor.bridge.waiter')).toBe(false);
    expect(diagnosticsCodes(run)).toContain('BRIDGE_WAITER_UNBOUNDED');
  });

  it('fails closed on a mixed raster v2 probe instead of launching a partially migrated harness', async () => {
    const { run } = await runDoctorWithBridge(
      v3Inspection({
        rasterProbe: {
          id: 'layout-1',
          isPromise: true,
          schemaVersion: 2,
          status: 'not-applicable',
          hasObservation: true,
        },
      }),
    );
    expect(run.harnessInvalid).toBe(true);
    expect(run.behaviorOutcome).toBe('HARNESS_BLOCKED');
    expect(checkPassed(run, 'doctor.bridge.raster')).toBe(false);
    expect(diagnosticsCodes(run)).toContain('RASTER_SCHEMA_UNSUPPORTED');
    expect(diagnosticsCodes(run)).not.toContain('BRIDGE_VERSION_MISMATCH');
  });

  it('reports a stale scenegraph mirror as a warning without treating it as rendered truth', async () => {
    const payload = v3Inspection();
    const doctor = payload.doctor as Record<string, unknown>;
    doctor.state = { ...(doctor.state as Record<string, unknown>), scenegraphInSync: false };
    const { run, allocation } = await runDoctorWithBridge(payload);

    expect(checkPassed(run, 'doctor.state.scenegraph')).toBe(true);
    expect(run.harnessInvalid).toBe(false);
    expect(run.behaviorOutcome).toBe('PASS');

    const stale = run.result.diagnostics.find(
      (entry) => entry.code === 'ARTWORK_SCENEGRAPH_MIRROR_STALE',
    );
    expect(stale?.severity).toBe('warning');

    const written = JSON.parse(
      readFileSync(path.join(allocation.scratchRoot, 'candidates', 'doctor.json'), 'utf8'),
    ) as { state: { scenegraphInSync: boolean | null } };
    expect(written.state.scenegraphInSync).toBe(false);
  });

  it('records the environment facts observed from the live page as evidence', async () => {
    const { run, allocation, cell } = await runDoctorWithBridge(v3Inspection());

    expect(checkPassed(run, 'doctor.environment.cell')).toBe(true);
    expect(run.result.environmentMismatches).toEqual([]);
    expect(run.result.environmentObserved).toEqual({
      viewport: { ...cell.viewport },
      devicePixelRatio: cell.deviceScaleFactor,
      language: cell.locale,
      timezoneId: cell.timezoneId,
      colorScheme: cell.colorScheme,
      reducedMotion: cell.reducedMotion,
    });

    const written = JSON.parse(
      readFileSync(path.join(allocation.scratchRoot, 'candidates', 'doctor.json'), 'utf8'),
    ) as {
      environmentObserved: Record<string, unknown>;
      environmentMismatches: unknown[];
    };
    expect(written.environmentObserved).toEqual(run.result.environmentObserved);
    expect(written.environmentMismatches).toEqual([]);
  });

  it('fails closed when the live page drifts from the governed environment cell', async () => {
    const { run } = await runDoctorWithBridge(v3Inspection(), {
      observedEnvironment: {
        viewport: { width: 800, height: 600 },
        devicePixelRatio: 2,
        language: 'fr-FR',
        timezoneId: 'Europe/Paris',
        colorScheme: 'dark',
        reducedMotion: 'reduce',
      },
    });

    expect(checkPassed(run, 'doctor.environment.cell')).toBe(false);
    expect(run.harnessInvalid).toBe(false);
    expect(run.environmentInvalid).toBe(true);
    expect(run.behaviorOutcome).toBe('ENVIRONMENT_FAILURE');
    expect(run.result.environmentMismatches.map((entry) => entry.fact)).toEqual([
      'viewport',
      'devicePixelRatio',
      'locale',
      'timezoneId',
      'colorScheme',
      'reducedMotion',
    ]);
    expect(diagnosticsCodes(run)).toContain('ENVIRONMENT_CELL_MISMATCH');
  });

  it('keeps the live-page observation callback free of bundler-injected name helpers', () => {
    // The CLI runs through `tsx`, whose esbuild `keepNames` transform injects
    // `__name(...)` calls into nested function bodies. Playwright serializes the
    // callback source and that helper does not exist in the page, so a nested
    // function in the observation callback fails at runtime with
    // `ReferenceError: __name is not defined`. This guard runs the real tsx
    // transform so the regression is caught without launching a browser.
    const repoRoot = resolveRepoRoot();
    const tsxCli = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
    const modulePath = path.join(resolveToolkitRoot(), 'src', 'browser', 'doctor.ts');
    const script = `import(${JSON.stringify(modulePath)}).then((m) => { const s = String(m.observeBrowserEnvironmentFacts) + String(m.buildDoctorBridgeInspectionScript); process.stdout.write(s.includes('__name') ? 'NAME_HELPER' : 'SELF_CONTAINED'); });`;

    const output = execFileSync(process.execPath, [tsxCli, '-e', script], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    expect(output.trim()).toBe('SELF_CONTAINED');
  }, 60_000);
});
