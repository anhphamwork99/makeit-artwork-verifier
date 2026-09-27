import { rmSync } from 'node:fs';
import path from 'node:path';

import { chromium } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { allocateRun } from '../../src/allocation/allocate';
import {
  admitCase,
  evidenceRootFor,
  expectedDistDirFor,
  releaseCase,
  scratchRootFor,
} from '../../src/allocation/lease';
import { activateControl, pointerClick, setFileInput } from '../../src/browser/primitives';
import { closeBrowserSession } from '../../src/browser/doctor';
import { openFreshPage, type BrowserSession } from '../../src/browser/launch';
import {
  createSetupAuthorization,
  deliverSetupAuthorization,
  invokeSetupConstructor,
  readSetupStatus,
  type SetupConstructorOutcome,
} from '../../src/browser/seam';
import { loadCatalogueBundle } from '../../src/catalogue/load';
import {
  findResource,
  loadResourceManifest,
  RESOURCE_FILES_RELATIVE_PATH,
} from '../../src/catalogue/resources';
import { resolveBindingFixture } from '../../src/catalogue/fixtures';
import { cleanupRun } from '../../src/cleanup/cleanup';
import { SETUP_GLOBAL_NAME, SETUP_ROUTE } from '../../src/contracts/seam';
import type { RunAllocation } from '../../src/contracts/runtime';
import { resolveAllResources, type ResolvedResource } from '../../src/resources/resolve';
import { registerResourceRoutes, type InstalledResourceRoutes } from '../../src/resources/routes';
import { loadEnvironmentCatalogue, resolveEnvironmentCell } from '../../src/runtime/environment';
import { launchOwnedServer } from '../../src/runtime/launch';
import { generateRunId } from '../../src/runtime/run-id';

/**
 * Supervisor R13 required dedicated test 31 — `context closure revokes remaining
 * product blob without harness revocation`.
 *
 * Real Chromium, real owned runtime, real native file input: the seller upload
 * installs A, the real replacement installs B, and the product revokes A through
 * its own layer lifecycle. The test then proves the *browser* disposes the
 * remaining B blob when the real owned document is destroyed: B is fetchable
 * from a second same-context page while installed (control) and unfetchable once
 * the owned page's document is closed. The harness never calls
 * `URL.revokeObjectURL`; only the product's own page-context calls are observed.
 */

const RUN_ID = generateRunId();
const CASE_ID = 'image-blob-context-lifecycle';
const TARGET_ID = 'layout-image-a-image-1';
const ACCEPT = 'image/png,image/jpeg';

const harnessRevoke = vi.fn();
/** Product page-context revocations observed through the init-script recorder. */
const productRevokes: string[] = [];

let allocation: RunAllocation | null = null;
let session: BrowserSession | null = null;
let installedRoutes: InstalledResourceRoutes | null = null;
const consoleErrors: string[] = [];

interface BridgeGeometryView {
  hitPoint?: { x: number; y: number };
  viewportRect?: { x: number; y: number; width: number; height: number };
}

function resourceFor(role: string): ResolvedResource {
  const manifest = loadResourceManifest();
  const bundle = loadCatalogueBundle();
  const fixture = resolveBindingFixture(bundle.fixtureCatalogue, {
    subjectId: 'layer/image',
    capability: 'changeProperties',
    scenarioId: 'replace-image',
  });
  const ref = fixture?.resourceRefs?.find((entry) => entry.role === role) ?? null;
  if (ref === null) throw new Error(`fixture declares no resource role "${role}"`);
  if (findResource(manifest, ref.logicalId, ref.version) === null) {
    throw new Error(`manifest does not declare "${ref.logicalId}@${ref.version}"`);
  }
  if (allocation === null) throw new Error('allocation is not ready');
  const resolved = resolveAllResources({
    manifest,
    filesRoot: path.join(allocation.skillRoot, RESOURCE_FILES_RELATIVE_PATH),
    origin: new URL(allocation.baseUrl).origin,
    runId: RUN_ID,
    executionInstanceId: RUN_ID,
  });
  const match = resolved.find(
    (entry) => entry.logicalId === ref.logicalId && entry.version === ref.version,
  );
  if (!match) throw new Error(`resource "${ref.logicalId}@${ref.version}" did not resolve`);
  return match;
}

async function readTargetGeometry(): Promise<BridgeGeometryView> {
  if (!session) throw new Error('browser session is not open');
  return session.page.evaluate(
    `(() => {
  const bridge = window.__MAKEIT_ARTWORK_VERIFICATION__;
  return bridge.geometry(${JSON.stringify(TARGET_ID)});
})()`,
  ) as Promise<BridgeGeometryView>;
}

async function readInstalledBlobUrl(): Promise<string> {
  if (!session) throw new Error('browser session is not open');
  return session.page.evaluate(
    `(() => {
  const bridge = window.__MAKEIT_ARTWORK_VERIFICATION__;
  const snapshot = bridge.snapshot();
  for (const layout of snapshot.layoutItems) {
    for (const layer of layout.layers ?? []) {
      if (layer.id === ${JSON.stringify(TARGET_ID)}) return layer.src ?? '';
    }
  }
  return '';
})()`,
  ) as Promise<string>;
}

async function waitForRasterSource(sha256: string): Promise<void> {
  if (!session) throw new Error('browser session is not open');
  await session.page.waitForFunction(
    ({ id, sha }) => {
      const bridge = (window as unknown as Record<string, unknown>)[
        '__MAKEIT_ARTWORK_VERIFICATION__'
      ] as
        | {
            raster: (
              id: string,
            ) => Promise<{ status?: unknown; source?: { sha256?: unknown } | null }>;
          }
        | undefined;
      if (!bridge) return false;
      return bridge
        .raster(id)
        .then((record) => record.status === 'ready' && record.source?.sha256 === sha)
        .catch(() => false);
    },
    { id: TARGET_ID, sha: sha256 },
    { timeout: 30_000 },
  );
}

async function waitForMountedTarget(): Promise<void> {
  if (!session) throw new Error('browser session is not open');
  await session.page.waitForFunction(
    (id) => {
      const bridge = (window as unknown as Record<string, unknown>)[
        '__MAKEIT_ARTWORK_VERIFICATION__'
      ] as
        | {
            geometry: (id: string) => {
              mounted?: unknown;
              visible?: unknown;
              listening?: unknown;
              hitPoint?: unknown;
            };
          }
        | undefined;
      if (!bridge) return false;
      const view = bridge.geometry(id);
      return view.mounted === true && view.visible === true && Boolean(view.hitPoint);
    },
    TARGET_ID,
    { timeout: 30_000 },
  );
}

async function controlVisible(accessibleName: string): Promise<boolean> {
  if (!session) return false;
  const buttons = await session.page
    .getByRole('button', { name: accessibleName, exact: true })
    .all();
  for (const button of buttons) {
    if (await button.isVisible()) return true;
  }
  return false;
}

/**
 * Selects the target with a real native click until its public toolbar control
 * is visible. The retry absorbs first-paint/hydration timing without a fixed
 * sleep on the product path.
 */
async function selectTargetUntilControlReady(accessibleName: string): Promise<void> {
  if (!session) throw new Error('browser session is not open');
  const { page } = session;
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (await controlVisible(accessibleName)) return;
    const geometry = await readTargetGeometry();
    if (geometry.hitPoint && geometry.viewportRect) {
      await pointerClick({
        page,
        target: { hitPoint: geometry.hitPoint, viewportRect: geometry.viewportRect },
      });
    }
    await page.waitForTimeout(200);
    if (Date.now() > deadline) {
      const names = await page.getByRole('button').allTextContents();
      throw new Error(
        `control "${accessibleName}" never became visible; visible button names: ${names.join(' | ')}`,
      );
    }
  }
}

async function activateWhenReady(accessibleName: string): Promise<void> {
  if (!session) throw new Error('browser session is not open');
  const { page } = session;
  const deadline = Date.now() + 20_000;
  let detail = 'not attempted';
  for (;;) {
    const result = await activateControl({ page, accessibleName });
    if (result.ok) return;
    detail = result.detail;
    if (Date.now() > deadline) {
      const names = await page.getByRole('button').allTextContents();
      throw new Error(
        `control "${accessibleName}" unavailable: ${detail}; visible button names: ${names.join(' | ')}`,
      );
    }
    await page.waitForTimeout(100);
  }
}

beforeAll(async () => {
  // The harness (Node) must never call the browser blob API; record any call.
  (URL as unknown as Record<string, unknown>).revokeObjectURL = harnessRevoke;

  const bundle = loadCatalogueBundle();
  const allocationResult = await allocateRun({ runId: RUN_ID });
  if (!allocationResult.ok) throw new Error(`allocation failed: ${allocationResult.detail}`);
  allocation = allocationResult.allocation;
  const admission = admitCase(RUN_ID, CASE_ID);
  if (!admission.ok) throw new Error(`admission failed: ${admission.detail}`);
  const launch = await launchOwnedServer({ allocation, readinessDeadlineMs: 300_000 });
  if (!launch.ok) throw new Error(`owned launch failed: ${launch.detail}`);

  const upload = resourceFor('upload-initial');
  const replacement = resourceFor('replace-final');
  const environment = resolveEnvironmentCell(
    loadEnvironmentCatalogue(),
    allocation.environmentCellId,
  );
  session = await openFreshPage({
    baseUrl: allocation.baseUrl,
    route: SETUP_ROUTE,
    environment,
    navigationTimeoutMs: 60_000,
    beforeNavigate: async (context) => {
      installedRoutes = await registerResourceRoutes({
        context,
        origin: new URL(allocation?.baseUrl as string).origin,
        resources: [upload, replacement],
        runId: RUN_ID,
      });
      // Product page-context revocations are observed, never issued, by the
      // harness. The binding forwards each call to Node for the assertion.
      await context.exposeBinding('__makeitRecordRevoke', (_source, url: unknown) => {
        productRevokes.push(String(url));
      });
      await context.addInitScript(() => {
        const original = URL.revokeObjectURL.bind(URL);
        URL.revokeObjectURL = (url: string): void => {
          try {
            (
              window as unknown as { __makeitRecordRevoke?: (value: string) => void }
            ).__makeitRecordRevoke?.(String(url));
          } catch {
            // Recording is best-effort; revocation itself must still happen.
          }
          original(url);
        };
      });
    },
  });
  const { page } = session;
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  await page.waitForFunction(
    (name) => Boolean((window as unknown as Record<string, unknown>)[name]),
    SETUP_GLOBAL_NAME,
    { timeout: 30_000 },
  );
  await page.waitForFunction(
    () => Boolean((window as unknown as Record<string, unknown>).__MAKEIT_ARTWORK_VERIFICATION__),
    undefined,
    { timeout: 30_000 },
  );
}, 360_000);

afterAll(async () => {
  let browserClosed = true;
  if (session) {
    const closeOutcome = await closeBrowserSession(session);
    browserClosed = closeOutcome.closed;
  }
  try {
    releaseCase(RUN_ID);
    if (allocation) {
      await cleanupRun(RUN_ID, {
        browserCleanup: { closed: browserClosed, detail: browserClosed ? null : 'close failed' },
      });
      rmSync(evidenceRootFor(RUN_ID), { recursive: true, force: true });
      rmSync(scratchRootFor(RUN_ID), { recursive: true, force: true });
      rmSync(expectedDistDirFor(RUN_ID), { recursive: true, force: true });
    }
  } finally {
    delete (URL as unknown as Record<string, unknown>).revokeObjectURL;
  }
}, 300_000);

describe('test 31 — real owned context disposal releases the remaining product blob', () => {
  it('keeps B installed, lets the browser dispose it on document close, and never revokes from the harness', async () => {
    if (!session || !allocation) throw new Error('owned run is not ready');
    const { page } = session;
    const upload = resourceFor('upload-initial');
    const replacement = resourceFor('replace-final');

    // ── One-shot construction of the image fixture through the real seam.
    const status = await readSetupStatus(page);
    if (!status) throw new Error('setup status unavailable');
    const authorization = createSetupAuthorization({
      runId: RUN_ID,
      caseId: CASE_ID,
      origin: new URL(allocation.baseUrl).origin,
      documentId: status.document.documentId,
    });
    await deliverSetupAuthorization(page, authorization);
    const constructed: SetupConstructorOutcome = await invokeSetupConstructor(page, {
      constructorId: 'artwork.two-layout-image.v1',
      constructorVersion: 1,
      scope: { runId: RUN_ID, caseId: CASE_ID },
      inputs: {
        artworkWidth: 500,
        artworkHeight: 500,
        imageFrame: { width: 320, height: 240 },
        layouts: [
          { id: 'layout-image-a', name: 'Image Layout', x: 80, y: 60 },
          { id: 'layout-image-control', name: 'Control Layout', x: 660, y: 60 },
        ],
      },
    });
    expect(constructed.ok).toBe(true);
    if (!constructed.ok) throw new Error(`expected construction, got ${constructed.code}`);

    // ── Real native upload A, then real replacement B.
    await waitForMountedTarget();
    await selectTargetUntilControlReady('Test with image');
    await activateWhenReady('Test with image');
    expect(
      (
        await setFileInput({
          page,
          dialogAccessibleName: 'Test with image',
          accept: ACCEPT,
          resource: upload,
        })
      ).ok,
    ).toBe(true);
    await waitForRasterSource(upload.sha256);
    const blobA = await readInstalledBlobUrl();
    expect(blobA.startsWith('blob:')).toBe(true);

    await activateWhenReady('Replace image');
    expect(
      (
        await setFileInput({
          page,
          dialogAccessibleName: 'Test with image',
          accept: ACCEPT,
          resource: replacement,
        })
      ).ok,
    ).toBe(true);
    await waitForRasterSource(replacement.sha256);
    const blobB = await readInstalledBlobUrl();
    expect(blobB.startsWith('blob:')).toBe(true);
    expect(blobB).not.toBe(blobA);

    // The product revoked A through its own layer lifecycle on replacement and
    // still has B installed.
    expect(productRevokes).toContain(blobA);
    expect(productRevokes).not.toContain(blobB);

    // ── Control: B is a live product blob fetchable from a second page of the
    // same real owned context.
    const control = await session.context.newPage();
    await control.goto(`${allocation.baseUrl}${SETUP_ROUTE}`, { waitUntil: 'domcontentloaded' });
    const fetchBlob = async (url: string): Promise<number> =>
      control.evaluate(async (target) => {
        try {
          const response = await fetch(target);
          return response.status;
        } catch {
          return 0;
        }
      }, url);
    expect(await fetchBlob(blobB)).toBe(200);

    // ── Close the real owned document while B is installed. The browser
    // disposes the remaining blob without the harness revoking anything.
    await page.close();
    expect(await fetchBlob(blobB)).toBe(0);
    expect(productRevokes).not.toContain(blobB);
    expect(harnessRevoke).not.toHaveBeenCalled();
    expect(blobA.startsWith('blob:')).toBe(true);

    await control.close();
    await installedRoutes?.unregister();
  }, 300_000);
});
