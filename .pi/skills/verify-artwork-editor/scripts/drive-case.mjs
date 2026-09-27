#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

const requireFromRepository = createRequire(path.join(process.cwd(), 'package.json'));
const { chromium } = requireFromRepository('@playwright/test');

function parseArgs(argv) {
  const [mode, ...rest] = argv;
  const values = { mode };
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index]?.replace(/^--/, '');
    const value = rest[index + 1];
    if (!key || value === undefined) throw new Error(`Invalid argument near ${rest[index]}`);
    values[key] = value;
  }
  return values;
}

async function writeJson(filePath, value) {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function clipAround(rect, viewport, padding = 24) {
  const x = Math.max(0, rect.x - padding);
  const y = Math.max(0, rect.y - padding);
  const right = Math.min(viewport.width, rect.x + rect.width + padding);
  const bottom = Math.min(viewport.height, rect.y + rect.height + padding);
  return {
    x,
    y,
    width: Math.max(1, right - x),
    height: Math.max(1, bottom - y),
  };
}

function assertCaseContract(testCase) {
  if (!testCase?.id || !testCase?.title) throw new Error('Case requires id and title.');
  if (testCase.fixture?.route !== '/artwork/editor') {
    throw new Error('Current driver requires fixture.route=/artwork/editor.');
  }
  if (![1, 2].includes(testCase.fixture?.layoutCount)) {
    throw new Error('Current driver supports fixture.layoutCount 1 or 2.');
  }
  if (testCase.fixture?.layer?.kind !== 'text') {
    throw new Error('Current driver supports fixture.layer.kind=text.');
  }
  if (testCase.fixture?.layer?.creationAction !== 'Add text') {
    throw new Error('Current driver requires the public Add text action.');
  }
  if (testCase.action?.type !== 'drag') {
    throw new Error('Current driver supports action.type=drag.');
  }
  for (const value of [
    testCase.action?.delta?.x,
    testCase.action?.delta?.y,
    testCase.expected?.minimumDelta?.x,
    testCase.expected?.minimumDelta?.y,
  ]) {
    if (!Number.isFinite(value))
      throw new Error('Drag and expectation deltas must be finite numbers.');
  }
}

function bridgeExpression(method, argument) {
  return { method, argument };
}

async function callBridge(page, method, argument) {
  return page.evaluate(
    ({ method: bridgeMethod, argument: bridgeArgument }) => {
      const bridge = window.__MAKEIT_ARTWORK_VERIFICATION__;
      if (!bridge) throw new Error('Artwork verification bridge is not installed.');
      return bridge[bridgeMethod](bridgeArgument);
    },
    bridgeExpression(method, argument),
  );
}

async function openOwnedPage(baseUrl, evidenceDir) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1512, height: 982 } });
  const page = await context.newPage();
  const consoleErrors = [];
  const failedRequests = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('requestfailed', (request) => {
    failedRequests.push({
      url: request.url(),
      error: request.failure()?.errorText ?? 'unknown',
    });
  });
  const response = await page.goto(`${baseUrl}/artwork/editor`, {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  });
  await page.waitForFunction(() => Boolean(window.__MAKEIT_ARTWORK_VERIFICATION__), null, {
    timeout: 30_000,
  });
  return {
    browser,
    context,
    page,
    responseStatus: response?.status() ?? null,
    consoleErrors,
    failedRequests,
    evidenceDir,
  };
}

async function doctor(baseUrl, evidenceDir) {
  const runtime = await openOwnedPage(baseUrl, evidenceDir);
  try {
    const { page } = runtime;
    const bridgeDoctor = await callBridge(page, 'doctor');
    await callBridge(page, 'waitForIdle');
    const title = await page.title();
    const finalUrl = page.url();
    const expectedLayers = [
      'artwork-boards',
      'artwork-smart-guides',
      'artwork-warp-handles',
      'artwork-drag-overlay',
    ];
    const missingLayers = expectedLayers.filter(
      (name) => !bridgeDoctor.stage.layerNames.includes(name),
    );
    if (bridgeDoctor.version !== 1)
      throw new Error(`Unexpected bridge version ${bridgeDoctor.version}.`);
    if (title !== 'Editor - Artwork') throw new Error(`Unexpected document title: ${title}`);
    if (new URL(finalUrl).pathname !== '/artwork/editor') {
      throw new Error(`Unexpected final route: ${finalUrl}`);
    }
    if (missingLayers.length > 0) {
      throw new Error(`Missing Konva Stage layers: ${missingLayers.join(', ')}`);
    }
    if (bridgeDoctor.state.layoutCount < 2) {
      throw new Error('Expected ordinary Layout plus virtual Canvas Layout.');
    }
    await page.screenshot({ path: path.join(evidenceDir, 'doctor.png') });
    const result = {
      ...bridgeDoctor,
      httpStatus: runtime.responseStatus,
      title,
      finalUrl,
      diagnostics: {
        consoleErrors: runtime.consoleErrors,
        failedRequests: runtime.failedRequests,
      },
    };
    await writeJson(path.join(evidenceDir, 'doctor.json'), result);
    return result;
  } catch (error) {
    await runtime.page.screenshot({
      path: path.join(evidenceDir, 'failure.png'),
      fullPage: false,
    });
    throw error;
  } finally {
    await runtime.context.close();
    await runtime.browser.close();
  }
}

async function drive(baseUrl, evidenceDir, testCase) {
  assertCaseContract(testCase);
  const runtime = await openOwnedPage(baseUrl, evidenceDir);
  const actions = [];
  const action = (name, detail = {}) =>
    actions.push({ at: new Date().toISOString(), name, ...detail });

  try {
    const { page } = runtime;
    await callBridge(page, 'waitForIdle');
    const initialLayout = await callBridge(page, 'geometry', 'layout-1');
    if (!initialLayout.hitPoint)
      throw new Error('Layout #1 has no verified native-input hit point.');

    action('select-layout', { id: 'layout-1', point: initialLayout.hitPoint });
    await page.mouse.click(initialLayout.hitPoint.x, initialLayout.hitPoint.y);

    if (testCase.fixture.layoutCount === 2) {
      action('click-control', { accessibleName: 'Create new layout' });
      await page.getByRole('button', { name: 'Create new layout' }).click();
      const onboarding = page.getByRole('button', { name: 'Got it' });
      if (await onboarding.isVisible()) {
        action('click-control', { accessibleName: 'Got it' });
        await onboarding.click();
      }
    }

    action('click-tool', { accessibleName: 'Text' });
    await page.getByRole('button', { name: 'Text', exact: true }).click();
    action('create-layer', { accessibleName: testCase.fixture.layer.creationAction });
    await page
      .getByRole('button', { name: testCase.fixture.layer.creationAction, exact: true })
      .click();
    await callBridge(page, 'waitForIdle');

    const selectedText = await callBridge(page, 'elements', {
      kind: 'text',
      selected: true,
      mounted: true,
    });
    if (selectedText.length !== 1) {
      throw new Error(`Expected one mounted selected Text layer, found ${selectedText.length}.`);
    }
    const layerId = selectedText[0].id;
    const beforeSnapshot = await callBridge(page, 'snapshot');
    const beforeGeometry = await callBridge(page, 'geometry', layerId);
    if (!beforeGeometry.hitPoint || !beforeGeometry.viewportRect) {
      throw new Error(`Text layer ${layerId} has no verified native-input hit point.`);
    }
    await page.screenshot({
      path: path.join(evidenceDir, 'before-layer.png'),
      clip: clipAround(beforeGeometry.viewportRect, { width: 1512, height: 982 }),
    });

    const start = beforeGeometry.hitPoint;
    const end = {
      x: start.x + testCase.action.delta.x,
      y: start.y + testCase.action.delta.y,
    };
    action('select-layer', { id: layerId, point: start });
    await page.mouse.click(start.x, start.y);
    action('drag-layer', { id: layerId, start, end, steps: 10 });
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(end.x, end.y, { steps: 10 });
    await page.mouse.up();
    await callBridge(page, 'waitForIdle');

    const afterSnapshot = await callBridge(page, 'snapshot');
    const afterGeometry = await callBridge(page, 'geometry', layerId);
    if (!afterGeometry.viewportRect) {
      throw new Error(`Text layer ${layerId} became unmounted after drag.`);
    }
    await page.screenshot({
      path: path.join(evidenceDir, 'after-layer.png'),
      clip: clipAround(afterGeometry.viewportRect, { width: 1512, height: 982 }),
    });

    const beforeNode = beforeSnapshot.contentNodes[layerId];
    const afterNode = afterSnapshot.contentNodes[layerId];
    if (!beforeNode || !afterNode)
      throw new Error('Selected Text layer is missing from content state.');
    const actualDelta = {
      x: afterNode.xCoordinate - beforeNode.xCoordinate,
      y: afterNode.yCoordinate - beforeNode.yCoordinate,
    };
    const konvaDelta = {
      x: afterGeometry.viewportRect.x - beforeGeometry.viewportRect.x,
      y: afterGeometry.viewportRect.y - beforeGeometry.viewportRect.y,
    };

    let undoneNode = null;
    let redoneNode = null;
    if (testCase.expected.undoRedo) {
      action('click-control', { titlePattern: 'Undo' });
      await page.getByTitle(/Undo/).click();
      await callBridge(page, 'waitForIdle');
      undoneNode = (await callBridge(page, 'snapshot')).contentNodes[layerId];

      action('click-control', { titlePattern: 'Redo' });
      await page.getByTitle(/Redo/).click();
      await callBridge(page, 'waitForIdle');
      redoneNode = (await callBridge(page, 'snapshot')).contentNodes[layerId];
    }

    const checks = {
      minimumDeltaX: Math.abs(actualDelta.x) >= Math.abs(testCase.expected.minimumDelta.x),
      minimumDeltaY: Math.abs(actualDelta.y) >= Math.abs(testCase.expected.minimumDelta.y),
      liveKonvaMovement:
        !testCase.expected.requireLiveKonvaMovement ||
        Math.abs(konvaDelta.x) > 0 ||
        Math.abs(konvaDelta.y) > 0,
      undoRestored:
        !testCase.expected.undoRedo ||
        (undoneNode?.xCoordinate === beforeNode.xCoordinate &&
          undoneNode?.yCoordinate === beforeNode.yCoordinate),
      redoRestored:
        !testCase.expected.undoRedo ||
        (redoneNode?.xCoordinate === afterNode.xCoordinate &&
          redoneNode?.yCoordinate === afterNode.yCoordinate),
    };
    const outcome = Object.values(checks).every(Boolean) ? 'PASS' : 'BUG';
    const result = {
      outcome,
      case: { id: testCase.id, title: testCase.title },
      expected: testCase.expected,
      actual: {
        layerId,
        contentDelta: actualDelta,
        liveKonvaDelta: konvaDelta,
        beforeNode,
        afterNode,
        undoneNode,
        redoneNode,
        beforeGeometry,
        afterGeometry,
      },
      checks,
      diagnostics: {
        scenegraphInSyncBefore: beforeSnapshot.scenegraphInSync,
        scenegraphInSyncAfter: afterSnapshot.scenegraphInSync,
        staleScenegraphNodeAfter: afterSnapshot.scenegraphNodes[layerId] ?? null,
        consoleErrors: runtime.consoleErrors,
        failedRequests: runtime.failedRequests,
      },
    };
    await writeJson(path.join(evidenceDir, 'actions.json'), actions);
    await writeJson(path.join(evidenceDir, 'result.json'), result);
    return result;
  } catch (error) {
    await writeJson(path.join(evidenceDir, 'actions.json'), actions);
    await runtime.page.screenshot({
      path: path.join(evidenceDir, 'failure.png'),
      fullPage: false,
    });
    await writeJson(path.join(evidenceDir, 'failure.json'), {
      outcome: 'HARNESS_BLOCKED',
      message: `${error.name}: ${error.message}`,
      actions,
      diagnostics: {
        consoleErrors: runtime.consoleErrors,
        failedRequests: runtime.failedRequests,
      },
    });
    throw error;
  } finally {
    await runtime.context.close();
    await runtime.browser.close();
  }
}

const args = parseArgs(process.argv.slice(2));
const evidenceDir = path.resolve(args.evidence);
const casePath = path.resolve(args.case);
await fs.mkdir(evidenceDir, { recursive: true });
const testCase = JSON.parse(await fs.readFile(casePath, 'utf8'));

if (args.mode === 'doctor') {
  await doctor(args['base-url'], evidenceDir);
} else if (args.mode === 'drive') {
  await drive(args['base-url'], evidenceDir, testCase);
} else {
  throw new Error(`Unknown mode: ${args.mode}`);
}
