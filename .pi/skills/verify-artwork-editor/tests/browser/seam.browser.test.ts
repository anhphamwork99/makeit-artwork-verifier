import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { chromium } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { allocateRun } from '../../src/allocation/allocate';
import {
  admitCase,
  evidenceRootFor,
  expectedDistDirFor,
  releaseCase,
  scratchRootFor,
} from '../../src/allocation/lease';
import {
  REQUIRED_STAGE_LAYERS,
  closeBrowserSession,
  compareObservedEnvironmentToCell,
  observeBrowserEnvironmentFacts,
} from '../../src/browser/doctor';
import { openFreshPage, type BrowserSession } from '../../src/browser/launch';
import type { RunAllocation } from '../../src/contracts/runtime';
import {
  createSetupAuthorization,
  deliverSetupAuthorization,
  invokeSetupConstructor,
  readSetupPageChannels,
  readSetupRefusals,
  readSetupSealRecord,
  readSetupStatus,
  setupBrokerIsPresent,
} from '../../src/browser/seam';
import { cleanupRun } from '../../src/cleanup/cleanup';
import {
  SETUP_BROKER_KEY_DESCRIPTION,
  SETUP_FORBIDDEN_TRANSPORT_CHANNELS,
  SETUP_GLOBAL_NAME,
  SETUP_ROUTE,
  setupSealRecordViolations,
  setupTransportLeaks,
  type SetupForbiddenTransportChannel,
  type SetupSealRecord,
} from '../../src/contracts/seam';
import { loadEnvironmentCatalogue, resolveEnvironmentCell } from '../../src/runtime/environment';
import { launchOwnedServer } from '../../src/runtime/launch';
import { generateRunId } from '../../src/runtime/run-id';

/**
 * Real owned-runtime setup/seal lifecycle proof (TS-3/TS-4, Gate C).
 *
 * Launches exactly one owned Next.js server, runs the read-only Doctor
 * observation first, and then walks the complete one-shot setup lifecycle in one
 * fresh Chromium context: refusal without mutation, authorization delivery, one
 * construction, immediate seal, replay/post-seal refusal, and a reload that
 * never reopens setup.
 */

const RUN_ID = generateRunId();

let session: BrowserSession | null = null;
let allocation: RunAllocation | null = null;
let setupEvidence: Record<string, unknown> = {};

interface BridgeObservation {
  version: number;
  route: string;
  document: { documentId: string; documentEpoch: number };
  stage: { mounted: boolean; width: number; height: number; layerNames: string[] };
  state: {
    rootCount: number;
    scenegraphRootCount: number;
    nodeCount: number;
    layoutCount: number;
    layerCount: number;
    scenegraphInSync: boolean;
  };
}

async function readBridgeSnapshot(): Promise<{
  rootIds: string[];
  scenegraphInSync: boolean;
  canUndo: boolean;
  canRedo: boolean;
  history: { pastDepth: number; futureDepth: number; baselineClean: boolean };
  elements: { id: string; kind: string; name: string | null }[];
}> {
  if (!session) throw new Error('browser session is not open');
  return session.page.evaluate(
    `(() => {
  const bridge = window.__MAKEIT_ARTWORK_VERIFICATION__;
  if (!bridge) return null;
  const snapshot = bridge.snapshot();
  return {
    rootIds: snapshot.rootIds,
    scenegraphInSync: snapshot.scenegraphInSync,
    canUndo: snapshot.canUndo,
    canRedo: snapshot.canRedo,
    history: snapshot.history,
    elements: bridge.elements().elements.map((element) => ({ id: element.id, kind: element.kind, name: element.name })),
  };
})()`,
  ) as Promise<{
    rootIds: string[];
    scenegraphInSync: boolean;
    canUndo: boolean;
    canRedo: boolean;
    history: { pastDepth: number; futureDepth: number; baselineClean: boolean };
    elements: { id: string; kind: string; name: string | null }[];
  }>;
}

async function readBridgeDoctor(): Promise<BridgeObservation> {
  if (!session) throw new Error('browser session is not open');
  return session.page.evaluate(
    `(() => {
  const bridge = window.__MAKEIT_ARTWORK_VERIFICATION__;
  if (!bridge) return null;
  return bridge.doctor();
})()`,
  ) as Promise<BridgeObservation>;
}

async function waitForSetupGlobal(): Promise<void> {
  if (!session) throw new Error('browser session is not open');
  await session.page.waitForFunction(
    (name) => Boolean((window as unknown as Record<string, unknown>)[name]),
    SETUP_GLOBAL_NAME,
    { timeout: 30_000 },
  );
}

const LIFECYCLE_INPUTS = {
  artworkWidth: 500,
  artworkHeight: 500,
  layouts: [
    { id: 'layout-a', name: 'Layout A', x: 0, y: 0, text: 'Alpha' },
    { id: 'layout-b', name: 'Layout B', x: 560, y: 0, text: 'Beta' },
  ],
};

function constructRequest(runId: string, caseId: string) {
  return {
    constructorId: 'artwork.two-layout-text.v1',
    constructorVersion: 1,
    scope: { runId, caseId },
    inputs: structuredClone(LIFECYCLE_INPUTS),
  };
}

beforeAll(async () => {
  const allocationResult = await allocateRun({ runId: RUN_ID });
  if (!allocationResult.ok) throw new Error(`allocation failed: ${allocationResult.detail}`);
  const owned = allocationResult.allocation;
  allocation = owned;

  const admission = admitCase(RUN_ID, 'setup-seal');
  if (!admission.ok) throw new Error(`admission failed: ${admission.detail}`);

  const launch = await launchOwnedServer({ allocation: owned, readinessDeadlineMs: 300_000 });
  if (!launch.ok) throw new Error(`owned launch failed: ${launch.detail}`);

  const environment = resolveEnvironmentCell(loadEnvironmentCatalogue(), owned.environmentCellId);
  session = await openFreshPage({
    baseUrl: owned.baseUrl,
    route: SETUP_ROUTE,
    environment,
    navigationTimeoutMs: 60_000,
  });
  await session.page.waitForFunction(
    () => Boolean((window as unknown as Record<string, unknown>).__MAKEIT_ARTWORK_VERIFICATION__),
    undefined,
    { timeout: 30_000 },
  );
  mkdirSync(owned.evidenceRoot, { recursive: true });
  writeFileSync(
    path.join(owned.evidenceRoot, 'environment.json'),
    `${JSON.stringify(
      {
        observed: await observeBrowserEnvironmentFacts(session.page),
        mismatches: compareObservedEnvironmentToCell(
          environment,
          await observeBrowserEnvironmentFacts(session.page),
        ),
        chromium: chromium.executablePath(),
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
}, 360_000);

afterAll(async () => {
  let browserClosed = true;
  if (session) {
    const closeOutcome = await closeBrowserSession(session);
    browserClosed = closeOutcome.closed;
  }
  try {
    if (allocation) {
      writeFileSync(
        path.join(allocation.evidenceRoot, 'setup-seal.json'),
        `${JSON.stringify(setupEvidence, null, 2)}\n`,
        'utf8',
      );
    }
  } finally {
    releaseCase(RUN_ID);
    await cleanupRun(RUN_ID, {
      browserCleanup: { closed: browserClosed, detail: browserClosed ? null : 'close failed' },
    });
    rmSync(evidenceRootFor(RUN_ID), { recursive: true, force: true });
    rmSync(scratchRootFor(RUN_ID), { recursive: true, force: true });
    rmSync(expectedDistDirFor(RUN_ID), { recursive: true, force: true });
  }
}, 300_000);

describe('[Gate C] real browser one-shot setup boundary lifecycle', () => {
  it('runs the exact lifecycle: gated refused → installed → SETUP_OPEN → one construction → SETUP_COMPLETE → SEALED', async () => {
    if (!session || !allocation) throw new Error('owned run is not ready');
    const { page } = session;

    // ── Doctor first: the read-only bridge reports the pre-setup preconditions.
    const doctor = await readBridgeDoctor();
    expect(doctor.version).toBe(7);
    expect(doctor.route).toBe(SETUP_ROUTE);
    expect(doctor.state.layoutCount).toBeGreaterThanOrEqual(2);
    expect(typeof doctor.state.scenegraphInSync).toBe('boolean');
    expect(doctor.stage.mounted).toBe(true);
    for (const layer of REQUIRED_STAGE_LAYERS) {
      expect(doctor.stage.layerNames).toContain(layer);
    }
    const preflightSnapshot = await readBridgeSnapshot();
    expect(preflightSnapshot.canUndo).toBe(false);
    expect(preflightSnapshot.canRedo).toBe(false);
    expect(preflightSnapshot.history.baselineClean).toBe(true);

    // ── The setup seam is installed on the gated no-id route, in SETUP_OPEN.
    await waitForSetupGlobal();
    const openStatus = await readSetupStatus(page);
    expect(openStatus).not.toBeNull();
    expect(openStatus?.lifecycle).toBe('SETUP_OPEN');
    expect(openStatus?.route).toBe(SETUP_ROUTE);
    expect(openStatus?.constructAttempted).toBe(false);
    expect(openStatus?.authorization).toBe('absent');
    // Both seams resolve the same browser-Document identity.
    expect(openStatus?.document.documentId).toBe(doctor.document.documentId);
    expect(SETUP_GLOBAL_NAME).not.toBe('__MAKEIT_ARTWORK_VERIFICATION__');

    // ── Doc 1: a wrong-run authorization refuses before mutation and seals.
    const wrongRun = createSetupAuthorization({
      runId: 'run-not-this-one',
      caseId: 'setup-seal',
      origin: new URL(allocation.baseUrl).origin,
      documentId: openStatus?.document.documentId ?? '',
    });
    await expect(setupBrokerIsPresent(page)).resolves.toBe(false);
    await deliverSetupAuthorization(page, wrongRun);
    await expect(setupBrokerIsPresent(page)).resolves.toBe(true);

    const refused = await invokeSetupConstructor(page, constructRequest(RUN_ID, 'setup-seal'));
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error('expected a refusal');
    expect(refused.code).toBe('SETUP_SCOPE_MISMATCH');
    expect(refused.context.dimension).toBe('run');
    expect(refused.mutationApplied).toBe(false);
    expect(refused.lifecycle).toBe('SEALED');
    const afterRefusal = await readBridgeSnapshot();
    expect(afterRefusal.rootIds).toEqual(preflightSnapshot.rootIds);
    expect(afterRefusal.canUndo).toBe(false);
    await expect(readSetupSealRecord(page)).resolves.toBeNull();
    await expect(setupBrokerIsPresent(page)).resolves.toBe(false);

    // ── Doc 2 (reload): the broker is never re-delivered, so setup cannot reopen.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForSetupGlobal();
    await expect(setupBrokerIsPresent(page)).resolves.toBe(false);
    const reloadStatus = await readSetupStatus(page);
    expect(reloadStatus?.lifecycle).toBe('SETUP_OPEN');
    expect(reloadStatus?.authorization).toBe('absent');
    expect(reloadStatus?.document.documentId).not.toBe(doctor.document.documentId);
    const noAuth = await invokeSetupConstructor(page, constructRequest(RUN_ID, 'setup-seal'));
    expect(noAuth.ok).toBe(false);
    if (noAuth.ok) throw new Error('expected a refusal');
    expect(noAuth.code).toBe('SETUP_AUTHORIZATION_MISSING');
    await expect(readSetupSealRecord(page)).resolves.toBeNull();

    // ── Doc 3 (reload): deliver the authorization for this Document and construct once.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForSetupGlobal();
    const constructStatus = await readSetupStatus(page);
    if (!constructStatus) throw new Error('setup status unavailable after reload');
    const authorization = createSetupAuthorization({
      runId: RUN_ID,
      caseId: 'setup-seal',
      origin: new URL(allocation.baseUrl).origin,
      documentId: constructStatus.document.documentId,
    });
    await deliverSetupAuthorization(page, authorization);

    const constructed = await invokeSetupConstructor(page, constructRequest(RUN_ID, 'setup-seal'));
    expect(constructed.ok).toBe(true);
    if (!constructed.ok) throw new Error(`expected a construction, got ${constructed.code}`);

    // ── Immediate seal: record, lifecycle trace, and consumed authorization.
    const sealRecord: SetupSealRecord = constructed.sealRecord;
    expect(sealRecord.outcome).toBe('constructed');
    expect(sealRecord.route).toBe(SETUP_ROUTE);
    expect(sealRecord.scope).toEqual({ runId: RUN_ID, caseId: 'setup-seal' });
    expect(sealRecord.document.documentId).toBe(constructStatus.document.documentId);
    expect(sealRecord.historyBaseline).toEqual({
      pastDepth: 0,
      futureDepth: 0,
      baselineClean: true,
    });
    expect(sealRecord.mutationSummary).toEqual({ constructCalls: 1, hydrateCalls: 1 });
    expect(sealRecord.semanticPrecondition.layoutCount).toBe(3);
    expect(sealRecord.semanticPrecondition.layerCount).toBe(2);
    expect(sealRecord.authorization.id).toBe(authorization.authorizationId);
    expect(
      setupSealRecordViolations(
        sealRecord as unknown as Record<string, unknown>,
        authorization.token,
      ),
    ).toEqual([]);

    const sealedStatus = await readSetupStatus(page);
    expect(sealedStatus?.lifecycle).toBe('SEALED');
    expect(sealedStatus?.lifecycleTrace).toEqual(['SETUP_OPEN', 'SETUP_COMPLETE', 'SEALED']);
    expect(sealedStatus?.authorization).toBe('consumed');
    expect(sealedStatus?.sealed).toBe(true);
    await expect(setupBrokerIsPresent(page)).resolves.toBe(false);
    await expect(readSetupSealRecord(page)).resolves.toEqual(sealRecord);

    // ── Post-seal: the read-only bridge reports the constructed preconditions.
    const postSealDoctor = await readBridgeDoctor();
    // The same Doctor preconditions still hold after the seal: the read-only
    // bridge is untouched by setup and reports the constructed fixture.
    expect(postSealDoctor.route).toBe(SETUP_ROUTE);
    expect(postSealDoctor.stage.mounted).toBe(true);
    for (const layer of REQUIRED_STAGE_LAYERS) {
      expect(postSealDoctor.stage.layerNames).toContain(layer);
    }
    expect(postSealDoctor.state.layoutCount).toBe(3);
    expect(postSealDoctor.state.layerCount).toBe(2);
    expect(postSealDoctor.state.scenegraphInSync).toBe(true);
    const postSeal = await readBridgeSnapshot();
    expect(postSeal.rootIds).toEqual(['__canvas__', 'layout-a', 'layout-b']);
    expect(postSeal.canUndo).toBe(false);
    expect(postSeal.canRedo).toBe(false);
    expect(postSeal.history).toEqual({ pastDepth: 0, futureDepth: 0, baselineClean: true });
    const textElements = postSeal.elements.filter((element) => element.kind === 'text');
    expect(textElements.map((element) => element.id).sort()).toEqual([
      'layout-a-text-1',
      'layout-b-text-1',
    ]);

    // ── Replay and post-seal calls refuse without mutating product state.
    const replay = await invokeSetupConstructor(page, constructRequest(RUN_ID, 'setup-seal'));
    expect(replay.ok).toBe(false);
    if (replay.ok) throw new Error('expected a replay refusal');
    expect(replay.code).toBe('SETUP_ALREADY_SEALED');
    expect(replay.mutationApplied).toBe(false);
    // A freshly delivered capability must not reopen the seal either.
    await deliverSetupAuthorization(
      page,
      createSetupAuthorization({
        runId: RUN_ID,
        caseId: 'setup-seal',
        origin: new URL(allocation.baseUrl).origin,
        documentId: constructStatus.document.documentId,
      }),
    );
    const postSealAttempt = await invokeSetupConstructor(
      page,
      constructRequest(RUN_ID, 'setup-seal'),
    );
    expect(postSealAttempt.ok).toBe(false);
    if (postSealAttempt.ok) throw new Error('expected a post-seal refusal');
    expect(postSealAttempt.code).toBe('SETUP_ALREADY_SEALED');
    expect(await readSetupRefusals(page)).toHaveLength(2);

    const afterPostSeal = await readBridgeSnapshot();
    expect(afterPostSeal.rootIds).toEqual(postSeal.rootIds);
    expect(afterPostSeal.canUndo).toBe(false);

    // ── Doc 4 (reload): the seal is invalidated and setup is never reopened.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForSetupGlobal();
    await expect(setupBrokerIsPresent(page)).resolves.toBe(false);
    const afterReloadStatus = await readSetupStatus(page);
    expect(afterReloadStatus?.lifecycle).toBe('SETUP_OPEN');
    expect(afterReloadStatus?.sealed).toBe(false);
    expect(afterReloadStatus?.constructAttempted).toBe(false);
    await expect(readSetupSealRecord(page)).resolves.toBeNull();
    const afterReloadDoctor = await readBridgeDoctor();
    expect(afterReloadDoctor.state.layoutCount).toBe(2);
    const afterReloadAttempt = await invokeSetupConstructor(
      page,
      constructRequest(RUN_ID, 'setup-seal'),
    );
    expect(afterReloadAttempt.ok).toBe(false);
    if (afterReloadAttempt.ok) throw new Error('expected a post-reload refusal');
    expect(afterReloadAttempt.code).toBe('SETUP_AUTHORIZATION_MISSING');

    // ── The raw capability reached no transport channel, log, or evidence file.
    const pageChannels = await readSetupPageChannels(page);
    const channels = {} as Record<SetupForbiddenTransportChannel, string>;
    for (const channel of SETUP_FORBIDDEN_TRANSPORT_CHANNELS) channels[channel] = '';
    for (const [channel, value] of Object.entries(pageChannels)) {
      if (value !== undefined) channels[channel as SetupForbiddenTransportChannel] = value;
    }
    const evidenceRoot = allocation.evidenceRoot;
    channels.log = readFileSync(path.join(allocation.scratchRoot, 'server.log'), 'utf8');
    channels.evidence = readdirSync(evidenceRoot)
      .map((entry) => readFileSync(path.join(evidenceRoot, entry), 'utf8'))
      .join('\n');
    channels.environment = Object.entries(process.env)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n');
    expect(setupTransportLeaks(channels, authorization.token)).toEqual([]);
    expect(
      setupSealRecordViolations(
        sealRecord as unknown as Record<string, unknown>,
        authorization.token,
      ),
    ).toEqual([]);
    expect(SETUP_BROKER_KEY_DESCRIPTION).toBe('makeit.artwork-setup.broker');

    // Evidence is written for the run, sanitized, and free of the raw capability.
    mkdirSync(allocation.evidenceRoot, { recursive: true });
    setupEvidence = {
      schemaVersion: 1,
      runId: RUN_ID,
      route: SETUP_ROUTE,
      lifecycle: sealedStatus?.lifecycleTrace,
      preflight: preflightSnapshot,
      postSeal: {
        rootIds: postSeal.rootIds,
        history: postSeal.history,
        layoutCount: postSealDoctor.state.layoutCount,
        layerCount: postSealDoctor.state.layerCount,
        scenegraphInSync: postSealDoctor.state.scenegraphInSync,
      },
      sealRecord,
      refusalCodes: [refused.code, noAuth.code, replay.code, afterReloadAttempt.code],
      testedSellerAction: false,
      leaks: [],
    };
    expect(JSON.stringify(setupEvidence)).not.toContain(authorization.token);
  }, 300_000);
});
