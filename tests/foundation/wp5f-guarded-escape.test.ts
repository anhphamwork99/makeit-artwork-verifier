/**
 * WP5 Slice 5-F — guarded Escape amendment contracts (ADR 0020 A2–A8).
 *
 * These are pure foundation tests for the closed amendment contract: the single
 * native Escape dispatch, the action-epoch separation, the zero-credit
 * boundary, the typed `More` attribution, the exact setup-history shape, and the
 * bound `HARNESS_BLOCKED` diagnostics. The real-browser proof lives in
 * `tests/browser/wp5f-guarded-escape.browser.test.ts` and supersedes the
 * retired `wp5f-history-probe` diagnostic probe.
 */

import { describe, expect, it } from 'vitest';

import {
  SELECTION_CLEAR_CREDIT,
  SELECTION_CLEAR_KEY,
  SELECTION_CLEAR_MAX_DISPATCHES,
  SELECTION_CLEAR_PRIMITIVE,
  SETUP_DIAGNOSTIC_CLASSIFICATION,
  assertHistoryActionEpoch,
  assertSetupHistoryH0H2,
  assertUniqueRailMore,
  attributeMoreControls,
  evaluateEscapeOwnership,
  historyTupleMatches,
  rejectAdditionalEscape,
  validateEscapeDispatch,
  type EscapeOwnershipFacts,
  type HistoryActionEpoch,
  type MoreControlCandidate,
  type SelectionClearEpoch,
} from '../../src/contracts/selection-clear';
import { DIAGNOSTIC_SEVERITY } from '../../src/contracts/diagnostics';

function candidate(overrides: Partial<MoreControlCandidate> = {}): MoreControlCandidate {
  return {
    accessibleName: 'More',
    title: null,
    nativeButton: true,
    buttonType: 'button',
    visible: true,
    enabled: true,
    ...overrides,
  };
}

const rail = candidate({ title: 'More' });
const toolbar = candidate({ title: null });

function safeFacts(overrides: Partial<EscapeOwnershipFacts> = {}): EscapeOwnershipFacts {
  return {
    createdPlaceholderResolvesOnce: true,
    createdPlaceholderSoleSelection: true,
    notEnteredGroupChildSelection: true,
    noActivePlacementOrEditingMode: true,
    focusNotEditable: true,
    noCompetingOverlayOwner: true,
    noResidualOnboarding: true,
    routeOwnedAndStable: true,
    meaningIsM2: true,
    historyIsH2: true,
    moreAttribution: 'rail+placeholder-toolbar',
    ...overrides,
  };
}

describe('[WP5 Slice 5-F] guarded Escape amendment contracts (ADR 0020 A2–A8)', () => {
  it('classifies two visible enabled exact-name More controls as rail + placeholder toolbar without dispatching', () => {
    const attribution = attributeMoreControls([rail, toolbar]);
    expect(attribution.actionableCount).toBe(2);
    expect(attribution.kind).toBe('rail+placeholder-toolbar');
    // Ambiguity is preserved: a title on one candidate never rescues the count.
    expect(attribution.candidates).toHaveLength(2);
  });

  it('cannot rescue global More ambiguity with a title-conjunctive predicate', () => {
    const attribution = attributeMoreControls([rail, candidate({ title: 'More' })]);
    expect(attribution.actionableCount).toBe(2);
    // Two titled candidates are not the attributable rail+toolbar shape.
    expect(attribution.kind).toBe('unattributable');
  });

  it('exposes no rail/ancestor scope option: attribution consumes resolved candidates only', () => {
    // A single candidate after the selected-layer candidate is removed resolves
    // as the sole rail control; the same resolver is reused with no scoping.
    expect(attributeMoreControls([rail]).kind).toBe('single-rail');
    expect(attributeMoreControls([rail]).actionableCount).toBe(1);
  });

  it('follows the closed resolver rules for hidden and disabled candidates with no first-match fallback', () => {
    const hidden = attributeMoreControls([rail, candidate({ visible: false })]);
    expect(hidden.actionableCount).toBe(1);
    expect(hidden.kind).toBe('single-rail');
    const disabled = attributeMoreControls([rail, candidate({ enabled: false })]);
    expect(disabled.actionableCount).toBe(1);
    expect(disabled.kind).toBe('single-rail');
    const wrongName = attributeMoreControls([candidate({ accessibleName: 'Object' }), rail]);
    expect(wrongName.actionableCount).toBe(1);
  });

  it('requires exactly one native keyboard.press Escape dispatch', () => {
    expect(SELECTION_CLEAR_PRIMITIVE).toBe('keyboard.press');
    expect(SELECTION_CLEAR_KEY).toBe('Escape');
    expect(SELECTION_CLEAR_MAX_DISPATCHES).toBe(1);
    expect(
      validateEscapeDispatch({
        escapeDispatchCount: 1,
        nativePrimitive: 'keyboard.press',
        key: 'Escape',
        dispatched: true,
      }),
    ).toBeNull();
    expect(
      validateEscapeDispatch({
        escapeDispatchCount: 0,
        nativePrimitive: 'keyboard.press',
        key: 'Escape',
        dispatched: false,
      })?.code,
    ).toBe('SETUP_ESCAPE_OWNER_UNSAFE');
    expect(
      validateEscapeDispatch({
        escapeDispatchCount: 1,
        nativePrimitive: 'page.evaluate',
        key: 'Escape',
        dispatched: true,
      })?.code,
    ).toBe('SETUP_ESCAPE_OWNER_UNSAFE');
    expect(
      validateEscapeDispatch({
        escapeDispatchCount: 1,
        nativePrimitive: 'keyboard.press',
        key: 'Enter',
        dispatched: true,
      })?.code,
    ).toBe('SETUP_ESCAPE_OWNER_UNSAFE');
  });

  it('structurally rejects a second Escape or retry deselection', () => {
    expect(
      rejectAdditionalEscape({
        escapeDispatchCount: 2,
        nativePrimitive: 'keyboard.press',
        key: 'Escape',
        dispatched: true,
      })?.code,
    ).toBe('SETUP_ESCAPE_OWNER_UNSAFE');
    expect(
      rejectAdditionalEscape({
        escapeDispatchCount: 1,
        nativePrimitive: 'keyboard.press',
        key: 'Escape',
        dispatched: true,
      }),
    ).toBeNull();
  });

  it('rejects a selectionClearEpochId as history-action epoch authority', () => {
    const historyEpoch: HistoryActionEpoch = {
      kind: 'history-action',
      historyActionEpochId: 'H:1',
      executionId: 'run',
      stepIndex: 0,
      preActionRevision: 3,
      armedAtMs: 0,
    };
    const selectionEpoch: SelectionClearEpoch = {
      kind: 'selection-clear',
      selectionClearEpochId: 'SC:1',
      executionId: 'run',
      stepIndex: 0,
      preActionRevision: 3,
      armedAtMs: 0,
    };
    expect(assertHistoryActionEpoch(historyEpoch, 'U1')).toBeNull();
    expect(assertHistoryActionEpoch(selectionEpoch, 'U1')?.code).toBe(
      'SETUP_SELECTION_CLEAR_HISTORY_CHANGED',
    );
    expect(assertHistoryActionEpoch(null, 'U1')?.code).toBe(
      'SETUP_SELECTION_CLEAR_HISTORY_CHANGED',
    );
  });

  it('declares the selection clear with zero history, create, capability, coverage, and Gate E credit', () => {
    expect(SELECTION_CLEAR_CREDIT).toEqual({
      historyActionEpochId: null,
      historyCredit: false,
      capabilityCredit: false,
      createCredit: false,
      coverageCredit: false,
      gateECredit: false,
    });
  });

  it('accepts only the exact committed setup history 0/1/2 and treats a selection-only revision as no transition', () => {
    expect(
      assertSetupHistoryH0H2([
        { pastDepth: 0, futureDepth: 0 },
        { pastDepth: 1, futureDepth: 0 },
        { pastDepth: 2, futureDepth: 0 },
      ]),
    ).toBeNull();
    // A selection-only Escape commits nothing: past depths stay 0/1/2.
    expect(
      assertSetupHistoryH0H2([
        { pastDepth: 0, futureDepth: 0 },
        { pastDepth: 1, futureDepth: 0 },
        { pastDepth: 2, futureDepth: 0 },
      ]),
    ).toBeNull();
    // A committed escape (pastDepth 3 at H2) is a shape failure.
    expect(
      assertSetupHistoryH0H2([
        { pastDepth: 0, futureDepth: 0 },
        { pastDepth: 1, futureDepth: 0 },
        { pastDepth: 3, futureDepth: 0 },
      ])?.code,
    ).toBe('SETUP_HISTORY_SHAPE_UNEXPECTED');
    expect(
      historyTupleMatches({ pastDepth: 3, futureDepth: 0 }, { pastDepth: 3, futureDepth: 0 }),
    ).toBe(true);
    expect(
      historyTupleMatches({ pastDepth: 3, futureDepth: 1 }, { pastDepth: 3, futureDepth: 0 }),
    ).toBe(false);
  });

  it('binds every A7 setup diagnostic to a blocking HARNESS_BLOCKED severity', () => {
    const entries = Object.entries(SETUP_DIAGNOSTIC_CLASSIFICATION);
    expect(entries.length).toBe(11);
    for (const [code, classification] of entries) {
      expect(classification).toBe('HARNESS_BLOCKED');
      expect(DIAGNOSTIC_SEVERITY[code as keyof typeof DIAGNOSTIC_SEVERITY]).toBe('blocking');
    }
  });

  it('blocks Escape when any ownership predicate is unsafe', () => {
    expect(evaluateEscapeOwnership(safeFacts()).ok).toBe(true);
    const unsafe: Array<Partial<EscapeOwnershipFacts>> = [
      { createdPlaceholderResolvesOnce: false },
      { createdPlaceholderSoleSelection: false },
      { notEnteredGroupChildSelection: false },
      { noActivePlacementOrEditingMode: false },
      { focusNotEditable: false },
      { noCompetingOverlayOwner: false },
      { noResidualOnboarding: false },
      { routeOwnedAndStable: false },
      { meaningIsM2: false },
      { historyIsH2: false },
      { moreAttribution: 'single-rail' },
    ];
    for (const override of unsafe) {
      const verdict = evaluateEscapeOwnership(safeFacts(override));
      expect(verdict.ok).toBe(false);
      expect(verdict.diagnostic?.code).toBe('SETUP_ESCAPE_OWNER_UNSAFE');
    }
  });

  it('asserts the unique post-clear More is the native rail button', () => {
    expect(
      assertUniqueRailMore({
        accessibleName: 'More',
        title: 'More',
        nativeButton: true,
        buttonType: 'button',
        visible: true,
        enabled: true,
      }),
    ).toBeNull();
    expect(
      assertUniqueRailMore({
        accessibleName: 'More',
        title: null,
        nativeButton: true,
        buttonType: 'button',
        visible: true,
        enabled: true,
      })?.code,
    ).toBe('SETUP_MORE_CONTROL_NOT_UNIQUE');
  });
});
