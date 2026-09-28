import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ArtworkEditorSnapshot } from '@/stores/artworkEditorStore';
import {
  canonicalizeNormalizedMeaning,
  fingerprintNormalizedMeaning,
  normalizeArtworkProductMeaning,
  type NormalizedArtworkMeaningV1,
} from '@/lib/artwork/verification/normalizedMeaningCore';

import { allocateRun } from '../../src/allocation/allocate';
import { admitCase, releaseCase } from '../../src/allocation/lease';
import { closeBrowserSession } from '../../src/browser/doctor';
import {
  clickUniqueTextRow,
  dismissInitialTutorial,
  dispatchEscapeOnce,
  observeCompetingOverlay,
  observeFocusedElement,
  observeInitialTutorial,
  observeMoreCandidates,
  observeOnboardingPopover,
  readUniqueRailMore,
} from '../../src/browser/guarded-setup';
import { openFreshPage, type BrowserSession } from '../../src/browser/launch';
import { activateControl } from '../../src/browser/primitives';
import {
  createSetupAuthorization,
  deliverSetupAuthorization,
  invokeSetupConstructor,
  readSetupStatus,
} from '../../src/browser/seam';
import { cleanupRun } from '../../src/cleanup/cleanup';
import {
  SETUP_HISTORY_EXPECTED,
  SELECTION_CLEAR_CREDIT,
  assertHistoryActionEpoch,
  assertSetupHistoryH0H2,
  assertUniqueRailMore,
  attributeMoreControls,
  evaluateEscapeOwnership,
  historyTupleMatches,
  rejectAdditionalEscape,
  validateEscapeDispatch,
  type EscapeOwnershipFacts,
  type SelectionClearEpoch,
  type SetupHistoryTuple,
} from '../../src/contracts/selection-clear';
import { OBSERVATION_GLOBAL_NAME, SETUP_GLOBAL_NAME, SETUP_ROUTE } from '../../src/contracts/seam';
import type { RunAllocation } from '../../src/contracts/runtime';
import { loadEnvironmentCatalogue, resolveEnvironmentCell } from '../../src/runtime/environment';
import { launchOwnedServer } from '../../src/runtime/launch';
import { generateRunId } from '../../src/runtime/run-id';

/**
 * WP5 Slice 5-F — guarded Escape amendment real-browser proof (ADR 0020 A1–A8).
 *
 * This dedicated test supersedes the retired `wp5f-history-probe` diagnostic
 * probe. It establishes the accepted post-seal seller setup sequence (Text →
 * Image placeholder) with the exact `M0/H0 … M2/H2` checkpoints, proves the
 * coherent A2 Escape-ownership predicate, dispatches exactly one native Escape,
 * proves the post-input preservation and the unique rail `More`, and then
 * completes the authoritative `More → Crossword` transition. It uses the
 * bridge's signal-first `waitForChange`/`waitForIdle` and Playwright
 * auto-waiting; it uses no fixed sleep, no retry, no second Escape, no store
 * call, and no evaluated event.
 */

const RUN_ID = generateRunId();
const CASE_ID = 'wp5f-guarded-escape';
const LIFECYCLE_INPUTS = {
  artworkWidth: 500,
  artworkHeight: 500,
  layouts: [
    { id: 'layout-a', name: 'Layout A', x: 0, y: 0, text: 'Alpha' },
    { id: 'layout-b', name: 'Layout B', x: 560, y: 0, text: 'Beta' },
  ],
};

interface LayoutItemView {
  id: string;
  isCanvas?: boolean;
  layers: Array<{ id: string; type: string }>;
}
interface BridgeSnapshotView {
  version: number;
  route: string;
  document: { documentId: string; documentEpoch: number };
  layoutItems: LayoutItemView[];
  activeLayoutId: string;
  selectedLayerIds: string[];
  canUndo: boolean;
  canRedo: boolean;
  history: { pastDepth: number; futureDepth: number; baselineClean: boolean };
}
interface BridgeStateView {
  snapshot: BridgeSnapshotView;
  cursor: { revision: number } & Record<string, unknown>;
}

let session: BrowserSession | null = null;
let allocation: RunAllocation | null = null;
const evidence: Record<string, unknown> = {};

function page(): BrowserSession['page'] {
  if (!session) throw new Error('browser session is not open');
  return session.page;
}

async function readState(): Promise<BridgeStateView> {
  const state = (await page().evaluate(`(() => {
    const bridge = window[${JSON.stringify(OBSERVATION_GLOBAL_NAME)}];
    if (!bridge) return null;
    return { snapshot: bridge.snapshot(), cursor: bridge.cursor() };
  })()`)) as BridgeStateView | null;
  if (!state) throw new Error('observation bridge is not available');
  return state;
}

/**
 * Signal-first bounded wait for a new committed history state, then renderer
 * quiescence, then a bounded no-change watchdog that proves the store is
 * settled. The image-creation path schedules a 100 ms debounced commit in
 * addition to its explicit commit; the watchdog lets that pending commit fire
 * and no-op *before* the guarded Escape, so the Escape's selection-only change
 * is never racing an in-flight history commit. No fixed sleep and no action
 * retry: the bridge waiter is the primary wake source and a timeout is a hard
 * failure.
 */
async function settleHistory(preCursor: BridgeStateView['cursor']): Promise<BridgeStateView> {
  const outcome = (await page().evaluate(
    `(async () => {
      const bridge = window[${JSON.stringify(OBSERVATION_GLOBAL_NAME)}];
      return await bridge.waitForChange({ after: ${JSON.stringify(preCursor)}, timeoutMs: 5000 });
    })()`,
  )) as { status: string };
  if (outcome.status !== 'changed') {
    throw new Error(
      `No committed history transition: bridge waitForChange reported "${outcome.status}".`,
    );
  }
  await page().evaluate(
    `(async () => {
      const bridge = window[${JSON.stringify(OBSERVATION_GLOBAL_NAME)}];
      return await bridge.waitForIdle({ stableFrames: 3, timeoutMs: 5000 });
    })()`,
  );
  const settled = await readState();
  return await awaitSettled(settled);
}

/** Bounded no-change watchdog proving no further committed store transition. */
async function awaitSettled(state: BridgeStateView): Promise<BridgeStateView> {
  let settled = state;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const watchdog = (await page().evaluate(
      `(async () => {
        const bridge = window[${JSON.stringify(OBSERVATION_GLOBAL_NAME)}];
        return await bridge.waitForChange({ after: ${JSON.stringify(settled.cursor)}, timeoutMs: 400 });
      })()`,
    )) as { status: string };
    if (watchdog.status === 'timeout') return settled;
    if (watchdog.status !== 'changed') {
      throw new Error(`Store quiescence watchdog was invalidated ("${watchdog.status}").`);
    }
    settled = await readState();
  }
  throw new Error('Store did not reach a settled state within the bounded quiescence watchdog.');
}

function retained(snapshot: BridgeSnapshotView, layoutId: string): LayoutItemView {
  const item = snapshot.layoutItems.find((entry) => entry.id === layoutId);
  if (!item) throw new Error(`retained Layout "${layoutId}" is not present`);
  return item;
}

function layerIds(snapshot: BridgeSnapshotView, layoutId: string): string[] {
  return retained(snapshot, layoutId)
    .layers.map((layer) => layer.id)
    .sort();
}

function meaning(snapshot: BridgeSnapshotView): NormalizedArtworkMeaningV1 {
  return normalizeArtworkProductMeaning(snapshot as unknown as ArtworkEditorSnapshot);
}

function sameMeaning(a: NormalizedArtworkMeaningV1, b: NormalizedArtworkMeaningV1): boolean {
  return canonicalizeNormalizedMeaning(a) === canonicalizeNormalizedMeaning(b);
}

function historyTuple(snapshot: BridgeSnapshotView): SetupHistoryTuple {
  return { pastDepth: snapshot.history.pastDepth, futureDepth: snapshot.history.futureDepth };
}

/** The created-placeholder phase-ownership lookup: exactly one new IMAGE layer. */
function createdPlaceholderId(
  before: BridgeSnapshotView,
  after: BridgeSnapshotView,
  layoutId: string,
): string | null {
  const beforeIds = new Set(layerIds(before, layoutId));
  const created = retained(after, layoutId).layers.filter((layer) => !beforeIds.has(layer.id));
  if (created.length !== 1) return null;
  const only = created[0] as { id: string; type: string };
  return only.type === 'IMAGE' ? only.id : null;
}

beforeAll(async () => {
  const allocationResult = await allocateRun({ runId: RUN_ID });
  if (!allocationResult.ok) throw new Error(`allocation failed: ${allocationResult.detail}`);
  const owned = allocationResult.allocation;
  allocation = owned;
  mkdirSync(owned.evidenceRoot, { recursive: true });
  evidence.runId = RUN_ID;

  const admission = admitCase(RUN_ID, CASE_ID);
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
  await page().waitForFunction(
    (name) => Boolean((window as unknown as Record<string, unknown>)[name]),
    OBSERVATION_GLOBAL_NAME,
    { timeout: 30_000 },
  );
  await page().waitForFunction(
    (name) => Boolean((window as unknown as Record<string, unknown>)[name]),
    SETUP_GLOBAL_NAME,
    { timeout: 30_000 },
  );
}, 360_000);

afterAll(async () => {
  let browserClosed = true;
  if (session) browserClosed = (await closeBrowserSession(session)).closed;
  try {
    if (allocation) {
      writeFileSync(
        path.join(allocation.evidenceRoot, 'wp5f-guarded-escape.json'),
        `${JSON.stringify(evidence, null, 2)}\n`,
        'utf8',
      );
    }
  } finally {
    releaseCase(RUN_ID);
    await cleanupRun(RUN_ID, {
      browserCleanup: { closed: browserClosed, detail: browserClosed ? null : 'close failed' },
    });
  }
}, 300_000);

describe('[WP5 Slice 5-F] guarded Escape amendment (ADR 0020 A1–A8)', () => {
  it('dismisses the tutorial without side effects, builds M2/H2 with one guarded Escape, then creates the Crossword at M3/H3', async () => {
    if (!session || !allocation) throw new Error('owned run is not ready');

    // ── Seal the accepted two-layout Text constructor (unchanged, no setup credit).
    const status = await readSetupStatus(page());
    if (!status) throw new Error('setup status unavailable');
    const authorization = createSetupAuthorization({
      runId: RUN_ID,
      caseId: CASE_ID,
      origin: new URL(allocation.baseUrl).origin,
      documentId: status.document.documentId,
    });
    await deliverSetupAuthorization(page(), authorization);
    const constructed = await invokeSetupConstructor(page(), {
      constructorId: 'artwork.two-layout-text.v1',
      constructorVersion: 1,
      scope: { runId: RUN_ID, caseId: CASE_ID },
      inputs: structuredClone(LIFECYCLE_INPUTS),
    });
    expect(constructed.ok, 'the accepted constructor must seal').toBe(true);
    if (!constructed.ok) return;
    const retainedLayoutId = constructed.sealRecord.semanticPrecondition.activeLayoutId;

    const initial = await readState();
    const route0 = page().url();
    const pages0 = session.context.pages().length;
    const document0 = initial.snapshot.document.documentId;
    const layout0 = layerIds(initial.snapshot, retainedLayoutId);
    const M0 = meaning(initial.snapshot);
    const H0 = historyTuple(initial.snapshot);
    evidence.H0 = { ...H0, layoutCount: layout0.length, candidateCount: H0.pastDepth };

    // ── A1: optional initial tutorial, dismissed with no meaning/history/inventory effect.
    const tutorialBefore = await observeInitialTutorial(page());
    const dismiss = await dismissInitialTutorial(page());
    evidence.tutorial = { ...tutorialBefore, dismissed: dismiss.dismissed };
    if (tutorialBefore.present) {
      expect(dismiss.dismissed, 'exactly one phase-owned tutorial Got it must be actionable').toBe(
        true,
      );
    }
    const afterTutorial = await readState();
    expect(afterTutorial.snapshot.history, 'tutorial dismissal preserves H0').toEqual(
      initial.snapshot.history,
    );
    expect(
      layerIds(afterTutorial.snapshot, retainedLayoutId),
      'tutorial preserves inventory',
    ).toEqual(layout0);
    expect(sameMeaning(meaning(afterTutorial.snapshot), M0), 'tutorial preserves M0').toBe(true);
    expect(page().url()).toBe(route0);
    expect(afterTutorial.snapshot.document.documentId).toBe(document0);

    // ── Setup 1: Text (non-credit precondition construction).
    expect((await activateControl({ page: page(), accessibleName: 'Text' })).ok).toBe(true);
    const preText = await readState();
    expect((await activateControl({ page: page(), accessibleName: 'Add text' })).ok).toBe(true);
    const afterText = await settleHistory(preText.cursor);
    const H1 = historyTuple(afterText.snapshot);
    const M1 = meaning(afterText.snapshot);
    expect(H1, 'exact setup H1').toEqual(SETUP_HISTORY_EXPECTED.H1);
    expect(sameMeaning(M1, M0), 'Text creation changes meaning').toBe(false);

    // A deterministic negative: at H1 no placeholder exists, so the A2 guard
    // would block before any Escape (zero dispatch).
    const guardAtH1 = evaluateEscapeOwnership({
      createdPlaceholderResolvesOnce: false,
      createdPlaceholderSoleSelection: false,
      notEnteredGroupChildSelection: true,
      noActivePlacementOrEditingMode: true,
      focusNotEditable: true,
      noCompetingOverlayOwner: true,
      noResidualOnboarding: true,
      routeOwnedAndStable: true,
      meaningIsM2: false,
      historyIsH2: false,
      moreAttribution: attributeMoreControls(await observeMoreCandidates(page())).kind,
    });
    expect(guardAtH1.ok, 'the guard blocks before the guarded state exists').toBe(false);
    expect(guardAtH1.diagnostic?.code).toBe('SETUP_ESCAPE_OWNER_UNSAFE');

    // ── Setup 2: Image placeholder with phase-owned onboarding (A1).
    expect((await activateControl({ page: page(), accessibleName: 'Image' })).ok).toBe(true);
    evidence.addPlaceholderRow = await clickUniqueTextRow(page(), 'Add image placeholder');
    expect(evidence.addPlaceholderRow).toMatchObject({ ok: true, visibleMatches: 1 });
    await page().waitForFunction(
      `(() => {
        const nodes = Array.from(document.querySelectorAll('p, span, h1, h2, h3, h4'));
        return nodes.some((node) => node.offsetParent !== null && (node.textContent || '').trim() === 'Image placeholder');
      })()`,
      undefined,
      { timeout: 10_000 },
    );
    const onboarding = await observeOnboardingPopover(page(), 'Image placeholder');
    evidence.onboarding = onboarding;
    expect(onboarding.present, 'the fresh branch opens the phase-owned onboarding').toBe(true);
    expect(onboarding.gotItActionable, 'exactly one phase-owned Got it').toBe(1);

    // A1: the row click must not add a layer or commit history.
    const beforeGotIt = await readState();
    expect(historyTuple(beforeGotIt.snapshot), 'row click commits nothing').toEqual(H1);
    expect(layerIds(beforeGotIt.snapshot, retainedLayoutId), 'row click adds no layer').toEqual(
      layerIds(afterText.snapshot, retainedLayoutId),
    );

    const gotIt = await activateControl({ page: page(), accessibleName: 'Got it' });
    expect(gotIt.ok, 'the phase-owned Got it is the sole add trigger').toBe(true);
    const afterImage = await settleHistory(beforeGotIt.cursor);
    const H2 = historyTuple(afterImage.snapshot);
    const M2 = meaning(afterImage.snapshot);
    expect(H2, 'exact setup H2').toEqual(SETUP_HISTORY_EXPECTED.H2);
    expect(assertSetupHistoryH0H2([H0, H1, H2]), 'exact authored setup history 0/1/2').toBeNull();
    const placeholderId = createdPlaceholderId(
      afterText.snapshot,
      afterImage.snapshot,
      retainedLayoutId,
    );
    expect(placeholderId, 'exactly one created IMAGE placeholder').not.toBeNull();
    expect(sameMeaning(M2, M1), 'Image creation changes meaning').toBe(false);

    // ── A2: one coherent pre-input ownership observation.
    const preEscape = await awaitSettled(await readState());
    const selectedBefore = [...preEscape.snapshot.selectedLayerIds];
    const moreBefore = attributeMoreControls(await observeMoreCandidates(page()));
    const focus = await observeFocusedElement(page());
    const overlay = await observeCompetingOverlay(page());
    const residualOnboarding = await observeOnboardingPopover(page(), 'Image placeholder');
    const retainedBefore = layerIds(preEscape.snapshot, retainedLayoutId);
    const ownershipFacts: EscapeOwnershipFacts = {
      createdPlaceholderResolvesOnce: placeholderId !== null,
      createdPlaceholderSoleSelection:
        selectedBefore.length === 1 && selectedBefore[0] === placeholderId,
      notEnteredGroupChildSelection: !selectedBefore.some((id) => id !== placeholderId),
      noActivePlacementOrEditingMode: !focus.isEditableTarget,
      focusNotEditable: !focus.isEditableTarget,
      noCompetingOverlayOwner: !overlay.anyOpen,
      noResidualOnboarding: !residualOnboarding.present,
      routeOwnedAndStable: page().url().includes('/artwork/editor'),
      meaningIsM2: sameMeaning(meaning(preEscape.snapshot), M2),
      historyIsH2: historyTupleMatches(historyTuple(preEscape.snapshot), H2),
      moreAttribution: moreBefore.kind,
    };
    const ownership = evaluateEscapeOwnership(ownershipFacts);
    evidence.preEscape = {
      facts: ownershipFacts,
      ok: ownership.ok,
      failed: ownership.failed,
      selectedBefore,
      more: moreBefore,
      focus,
      overlay,
      meaningFingerprint: fingerprintNormalizedMeaning(meaning(preEscape.snapshot)),
      history: historyTuple(preEscape.snapshot),
    };
    expect(ownership.ok, `Escape ownership must be safe (${ownership.failed.join(', ')})`).toBe(
      true,
    );
    expect(moreBefore.actionableCount, 'two globally actionable More controls').toBe(2);
    expect(moreBefore.kind).toBe('rail+placeholder-toolbar');

    // ── A3/A6: exactly one native Escape, zero credit, no history epoch.
    const selectionClearEpoch: SelectionClearEpoch = {
      kind: 'selection-clear',
      selectionClearEpochId: 'SC:setup',
      executionId: RUN_ID,
      stepIndex: 2,
      preActionRevision: preEscape.cursor.revision,
      armedAtMs: 0,
    };
    expect(
      assertHistoryActionEpoch(selectionClearEpoch, 'More')?.code,
      'a selection-clear epoch is not history authority',
    ).toBe('SETUP_SELECTION_CLEAR_HISTORY_CHANGED');
    expect(SELECTION_CLEAR_CREDIT.historyCredit).toBe(false);
    const dispatch = await dispatchEscapeOnce(page());
    evidence.escapeDispatch = dispatch;
    expect(validateEscapeDispatch(dispatch), 'exactly one native Escape').toBeNull();
    expect(rejectAdditionalEscape(dispatch)).toBeNull();
    expect(
      rejectAdditionalEscape({ ...dispatch, escapeDispatchCount: 2 })?.code,
      'a second Escape is structurally rejected',
    ).toBe('SETUP_ESCAPE_OWNER_UNSAFE');

    // ── A4: coherent post-input preservation.
    const postEscape = await readState();
    const moreAfter = attributeMoreControls(await observeMoreCandidates(page()));
    const railMore = await readUniqueRailMore(page());
    const overlayAfter = await observeCompetingOverlay(page());
    const onboardingAfter = await observeOnboardingPopover(page(), 'Image placeholder');
    evidence.postEscape = {
      selected: [...postEscape.snapshot.selectedLayerIds],
      more: moreAfter,
      railMore,
      overlay: overlayAfter,
      onboarding: onboardingAfter,
      meaningFingerprint: fingerprintNormalizedMeaning(meaning(postEscape.snapshot)),
      history: historyTuple(postEscape.snapshot),
      route: page().url(),
    };
    expect(postEscape.snapshot.selectedLayerIds, 'selection is cleared').toHaveLength(0);
    expect(moreAfter.actionableCount, 'exactly one global More remains').toBe(1);
    expect(moreAfter.kind).toBe('single-rail');
    expect(railMore, 'the unique More is a native rail button').not.toBeNull();
    expect(assertUniqueRailMore(railMore!), 'unique rail More identity').toBeNull();
    expect(sameMeaning(meaning(postEscape.snapshot), M2), 'M2 is structurally preserved').toBe(
      true,
    );
    expect(historyTupleMatches(historyTuple(postEscape.snapshot), H2), 'H2 is preserved').toBe(
      true,
    );
    expect(postEscape.snapshot.canUndo).toBe(preEscape.snapshot.canUndo);
    expect(postEscape.snapshot.canRedo).toBe(preEscape.snapshot.canRedo);
    expect(layerIds(postEscape.snapshot, retainedLayoutId), 'inventory is unchanged').toEqual(
      retainedBefore,
    );
    expect(page().url(), 'route is unchanged').toBe(route0);
    expect(session.context.pages().length, 'no popup or new tab opened').toBe(pages0);
    expect(postEscape.snapshot.document.documentId, 'document identity is unchanged').toBe(
      document0,
    );
    expect(overlayAfter.anyOpen, 'no competing overlay was opened').toBe(false);
    expect(onboardingAfter.present, 'no residual onboarding').toBe(false);

    // ── A4/A8 continuation: authoritative rail More → Crossword at M3/H3.
    expect((await activateControl({ page: page(), accessibleName: 'More' })).ok).toBe(true);
    expect((await activateControl({ page: page(), accessibleName: 'Crossword' })).ok).toBe(true);
    const afterCrossword = await settleHistory(postEscape.cursor);
    const H3 = historyTuple(afterCrossword.snapshot);
    const M3 = meaning(afterCrossword.snapshot);
    evidence.H3 = H3;
    expect(H3, 'exact setup H3').toEqual(SETUP_HISTORY_EXPECTED.H3);
    expect(sameMeaning(M3, M2), 'Crossword creation changes meaning').toBe(false);
    expect(layerIds(afterCrossword.snapshot, retainedLayoutId).length).toBe(
      retainedBefore.length + 1,
    );

    // ── ADR 0019 R3/R4: the six native toolbar Undo/Redo transitions.
    const controlIdentities = (await page().evaluate(`(() => {
      const read = (title) => Array.from(document.querySelectorAll('button')).filter(
        (element) => element.getAttribute('title') === title,
      ).map((element) => ({
        title: element.getAttribute('title'),
        type: element.getAttribute('type'),
        disabled: element.disabled,
        visible: element.offsetParent !== null,
        tag: element.tagName,
      }));
      return { undo: read('Undo (\u2318Z)'), redo: read('Redo (\u2318\u21e7Z)') };
    })()`)) as { undo: unknown[]; redo: unknown[] };
    evidence.controlIdentities = controlIdentities;
    expect(controlIdentities.undo, 'exactly one native Undo control').toEqual([
      { title: 'Undo (\u2318Z)', type: 'button', disabled: false, visible: true, tag: 'BUTTON' },
    ]);
    expect(controlIdentities.redo, 'exactly one native disabled Redo control at H3').toEqual([
      {
        title: 'Redo (\u2318\u21e7Z)',
        type: 'button',
        disabled: true,
        visible: true,
        tag: 'BUTTON',
      },
    ]);

    const historySteps: Array<{
      control: string;
      expected: SetupHistoryTuple;
      checkpoint: NormalizedArtworkMeaningV1;
    }> = [
      { control: 'Undo (\u2318Z)', expected: { pastDepth: 2, futureDepth: 1 }, checkpoint: M2 },
      { control: 'Undo (\u2318Z)', expected: { pastDepth: 1, futureDepth: 2 }, checkpoint: M1 },
      { control: 'Undo (\u2318Z)', expected: { pastDepth: 0, futureDepth: 3 }, checkpoint: M0 },
      {
        control: 'Redo (\u2318\u21e7Z)',
        expected: { pastDepth: 1, futureDepth: 2 },
        checkpoint: M1,
      },
      {
        control: 'Redo (\u2318\u21e7Z)',
        expected: { pastDepth: 2, futureDepth: 1 },
        checkpoint: M2,
      },
      {
        control: 'Redo (\u2318\u21e7Z)',
        expected: { pastDepth: 3, futureDepth: 0 },
        checkpoint: M3,
      },
    ];
    const transitions: Array<Record<string, unknown>> = [];
    for (const step of historySteps) {
      const before = await readState();
      const activated = await activateControl({ page: page(), accessibleName: step.control });
      expect(activated.ok, `${step.control} must be uniquely actionable before dispatch`).toBe(
        true,
      );
      const settled = await settleHistory(before.cursor);
      const tuple = historyTuple(settled.snapshot);
      const meaningMatches = sameMeaning(meaning(settled.snapshot), step.checkpoint);
      transitions.push({
        control: step.control,
        expected: step.expected,
        observed: tuple,
        meaningMatches,
      });
      expect(tuple, `${step.control} exact depth tuple`).toEqual(step.expected);
      expect(meaningMatches, `${step.control} restores the exact checkpoint meaning`).toBe(true);
    }
    evidence.transitions = transitions;
  }, 300_000);
});
