import { createDiagnostic, type DiagnosticCode, type DiagnosticRecord } from './diagnostics';

/**
 * Guarded selection-clearing contract (ADR 0020 A2–A7; WP5 Slice 5-F).
 *
 * After accepted Image-placeholder creation the product auto-selects the created
 * placeholder, so two globally actionable exact-name `More` buttons exist (the
 * seller rail and the selected-placeholder toolbar). ADR 0020 inserts exactly
 * one guarded native Escape — a seller-native, selection-only input — before the
 * global `More` resolver runs. This module is the *pure* closed contract for
 * that input: the dispatch primitive and count, the action-epoch separation, the
 * zero-credit boundary, the typed `More` attribution, the exact setup-history
 * shape, and the bound diagnostics.
 *
 * It never touches the DOM, the store, the bridge, or the product. The browser
 * harness (`src/browser/guarded-setup.ts`) performs the observations and calls
 * these predicates; a failed predicate is a `HARNESS_BLOCKED` precondition and
 * dispatches nothing.
 */

// ── Native dispatch contract (A3) ─────────────────────────────────────────────

/** The only permitted primitive. Evaluated events, callbacks, and store calls are refused. */
export const SELECTION_CLEAR_PRIMITIVE = 'keyboard.press' as const;
export const SELECTION_CLEAR_KEY = 'Escape' as const;
export const SELECTION_CLEAR_MAX_DISPATCHES = 1;

export const ESCAPE_OWNED_OVERLAY_ROLES = [
  'dialog',
  'alertdialog',
  'menu',
  'listbox',
  'combobox',
  'tooltip',
  'grid',
  'tree',
] as const;

export interface EscapeDispatchEvidence {
  escapeDispatchCount: number;
  nativePrimitive: string;
  key: string;
  /** True only after the single native `page.keyboard.press('Escape')`. */
  dispatched: boolean;
}

/** A structurally valid one-Escape dispatch, or the bound blocking diagnostic. */
export function validateEscapeDispatch(evidence: EscapeDispatchEvidence): DiagnosticRecord | null {
  if (!evidence.dispatched) {
    return createDiagnostic(
      'SETUP_ESCAPE_OWNER_UNSAFE',
      'Escape ownership was not affirmatively established, so no Escape was dispatched.',
    );
  }
  if (evidence.escapeDispatchCount !== SELECTION_CLEAR_MAX_DISPATCHES) {
    return createDiagnostic(
      'SETUP_ESCAPE_OWNER_UNSAFE',
      `Expected exactly ${SELECTION_CLEAR_MAX_DISPATCHES} Escape dispatch, observed ${evidence.escapeDispatchCount}.`,
    );
  }
  if (evidence.nativePrimitive !== SELECTION_CLEAR_PRIMITIVE) {
    return createDiagnostic(
      'SETUP_ESCAPE_OWNER_UNSAFE',
      `Escape must use the native "${SELECTION_CLEAR_PRIMITIVE}" primitive, not "${evidence.nativePrimitive}".`,
    );
  }
  if (evidence.key !== SELECTION_CLEAR_KEY) {
    return createDiagnostic(
      'SETUP_ESCAPE_OWNER_UNSAFE',
      `Escape dispatch must use key "${SELECTION_CLEAR_KEY}", not "${evidence.key}".`,
    );
  }
  return null;
}

/** A second Escape (or any further deselection gesture) is structurally rejected. */
export function rejectAdditionalEscape(evidence: EscapeDispatchEvidence): DiagnosticRecord | null {
  if (evidence.escapeDispatchCount > SELECTION_CLEAR_MAX_DISPATCHES) {
    return createDiagnostic(
      'SETUP_ESCAPE_OWNER_UNSAFE',
      `A second or retry Escape is prohibited; observed ${evidence.escapeDispatchCount} dispatches.`,
    );
  }
  return null;
}

// ── Action-epoch separation (A6) ──────────────────────────────────────────────

export interface HistoryActionEpoch {
  kind: 'history-action';
  historyActionEpochId: string;
  executionId: string;
  stepIndex: number;
  preActionRevision: number;
  armedAtMs: number;
}

export interface SelectionClearEpoch {
  kind: 'selection-clear';
  selectionClearEpochId: string;
  executionId: string;
  stepIndex: number;
  preActionRevision: number;
  armedAtMs: number;
}

export type ActionEpoch = HistoryActionEpoch | SelectionClearEpoch;

export function isHistoryActionEpoch(epoch: ActionEpoch): epoch is HistoryActionEpoch {
  return epoch.kind === 'history-action';
}

/**
 * A history Action Cycle requires a `historyActionEpochId`. A
 * `selectionClearEpochId` can never satisfy it (A6).
 */
export function assertHistoryActionEpoch(
  epoch: ActionEpoch | null,
  label: string,
): DiagnosticRecord | null {
  if (epoch === null) {
    return createDiagnostic(
      'SETUP_SELECTION_CLEAR_HISTORY_CHANGED',
      `${label} requires an armed history-action epoch, but none was armed.`,
    );
  }
  if (!isHistoryActionEpoch(epoch)) {
    return createDiagnostic(
      'SETUP_SELECTION_CLEAR_HISTORY_CHANGED',
      `${label} requires a history-action epoch; a selection-clear epoch is not history authority.`,
    );
  }
  return null;
}

// ── Zero-credit boundary (A6) ─────────────────────────────────────────────────

export interface SelectionClearCredit {
  historyActionEpochId: null;
  historyCredit: false;
  capabilityCredit: false;
  createCredit: false;
  coverageCredit: false;
  gateECredit: false;
}

export const SELECTION_CLEAR_CREDIT: SelectionClearCredit = Object.freeze({
  historyActionEpochId: null,
  historyCredit: false,
  capabilityCredit: false,
  createCredit: false,
  coverageCredit: false,
  gateECredit: false,
});

// ── Typed `More` attribution (A5) ─────────────────────────────────────────────

export interface MoreControlCandidate {
  accessibleName: string;
  title: string | null;
  nativeButton: boolean;
  buttonType: string | null;
  visible: boolean;
  enabled: boolean;
}

export type MoreAttributionKind = 'rail+placeholder-toolbar' | 'single-rail' | 'unattributable';

export interface MoreAttribution {
  /** Actionable candidates = exact-name `More`, visible and enabled. */
  actionableCount: number;
  candidates: readonly MoreControlCandidate[];
  kind: MoreAttributionKind;
}

/**
 * Attributes the actionable exact-name `More` set from product-authored facts.
 *
 * The seller rail `More` is a native `<button type="button">` with exact
 * accessible name *and* title `More`; the selected-placeholder toolbar `More`
 * (`ToolbarButton`) has the exact accessible name but no title. Attribution is
 * evidence only and is evaluated *after* the global role/name resolver has
 * established its count — title is never a selector predicate (A5).
 */
export function attributeMoreControls(
  candidates: readonly MoreControlCandidate[],
): MoreAttribution {
  const actionable = candidates.filter(
    (candidate) => candidate.accessibleName === 'More' && candidate.visible && candidate.enabled,
  );
  const withTitle = actionable.filter((candidate) => candidate.title === 'More');
  const withoutTitle = actionable.filter((candidate) => candidate.title === null);
  let kind: MoreAttributionKind = 'unattributable';
  if (actionable.length === 2 && withTitle.length === 1 && withoutTitle.length === 1) {
    kind = 'rail+placeholder-toolbar';
  } else if (actionable.length === 1 && withTitle.length === 1) {
    kind = 'single-rail';
  }
  return { actionableCount: actionable.length, candidates: actionable, kind };
}

export interface RailMoreIdentity {
  accessibleName: string;
  title: string | null;
  nativeButton: boolean;
  buttonType: string | null;
  visible: boolean;
  enabled: boolean;
}

/** The unique post-clear `More` must be the native rail `<button type="button">` (A4/A5). */
export function assertUniqueRailMore(identity: RailMoreIdentity): DiagnosticRecord | null {
  const ok =
    identity.accessibleName === 'More' &&
    identity.title === 'More' &&
    identity.nativeButton &&
    identity.buttonType === 'button' &&
    identity.visible &&
    identity.enabled;
  if (!ok) {
    return createDiagnostic(
      'SETUP_MORE_CONTROL_NOT_UNIQUE',
      'The unique post-clear `More` is not the native rail button with exact accessible name and title `More`.',
    );
  }
  return null;
}

// ── Exact setup-history shape (A1/A4) ─────────────────────────────────────────

export interface SetupHistoryTuple {
  pastDepth: number;
  futureDepth: number;
}

export const SETUP_HISTORY_EXPECTED = Object.freeze({
  H0: { pastDepth: 0, futureDepth: 0 },
  H1: { pastDepth: 1, futureDepth: 0 },
  H2: { pastDepth: 2, futureDepth: 0 },
  H3: { pastDepth: 3, futureDepth: 0 },
} as const satisfies Record<string, SetupHistoryTuple>);

export function historyTupleMatches(
  actual: SetupHistoryTuple,
  expected: SetupHistoryTuple,
): boolean {
  return actual.pastDepth === expected.pastDepth && actual.futureDepth === expected.futureDepth;
}

/** Exact committed setup history `0/1/2` (pre-Crossword); a selection clear adds nothing (A4). */
export function assertSetupHistoryH0H2(
  tuples: readonly SetupHistoryTuple[],
): DiagnosticRecord | null {
  const expected = [
    SETUP_HISTORY_EXPECTED.H0,
    SETUP_HISTORY_EXPECTED.H1,
    SETUP_HISTORY_EXPECTED.H2,
  ];
  if (tuples.length !== expected.length) {
    return createDiagnostic(
      'SETUP_HISTORY_SHAPE_UNEXPECTED',
      `Expected exactly ${expected.length} setup history checkpoints, observed ${tuples.length}.`,
    );
  }
  for (let index = 0; index < expected.length; index += 1) {
    const actual = tuples[index] as SetupHistoryTuple;
    const want = expected[index] as SetupHistoryTuple;
    if (!historyTupleMatches(actual, want)) {
      return createDiagnostic(
        'SETUP_HISTORY_SHAPE_UNEXPECTED',
        `Setup history H${index} is {${actual.pastDepth}/${actual.futureDepth}}, expected {${want.pastDepth}/${want.futureDepth}}.`,
      );
    }
  }
  return null;
}

// ── Bound diagnostic classification (A7) ──────────────────────────────────────

/**
 * Binding A7 diagnostic names and their single allowed classification. Every
 * failure before the authoritative `More`/`Crossword` transition is a
 * `HARNESS_BLOCKED` setup/precondition failure with no history, create,
 * Capability, coverage, or Gate E credit.
 */
export const SETUP_DIAGNOSTIC_CLASSIFICATION = Object.freeze({
  SETUP_TUTORIAL_CONTROL_UNAVAILABLE: 'HARNESS_BLOCKED',
  SETUP_ONBOARDING_CONTROL_AMBIGUOUS: 'HARNESS_BLOCKED',
  SETUP_IMAGE_ONBOARDING_ORDER_UNEXPECTED: 'HARNESS_BLOCKED',
  SETUP_HISTORY_SHAPE_UNEXPECTED: 'HARNESS_BLOCKED',
  SETUP_SELECTION_CLEAR_PRECONDITION_UNEXPECTED: 'HARNESS_BLOCKED',
  SETUP_MORE_AMBIGUITY_UNEXPECTED: 'HARNESS_BLOCKED',
  SETUP_ESCAPE_OWNER_UNSAFE: 'HARNESS_BLOCKED',
  SETUP_SELECTION_CLEAR_FAILED: 'HARNESS_BLOCKED',
  SETUP_SELECTION_CLEAR_MEANING_CHANGED: 'HARNESS_BLOCKED',
  SETUP_SELECTION_CLEAR_HISTORY_CHANGED: 'HARNESS_BLOCKED',
  SETUP_MORE_CONTROL_NOT_UNIQUE: 'HARNESS_BLOCKED',
} as const satisfies Record<string, 'HARNESS_BLOCKED'>);

export type SetupDiagnosticCode = keyof typeof SETUP_DIAGNOSTIC_CLASSIFICATION;

/** The bound `DiagnosticCode` for each A7 setup failure. There is no other mapping. */
export const SETUP_DIAGNOSTIC_CODE: Readonly<Record<SetupDiagnosticCode, DiagnosticCode>> =
  Object.freeze({
    SETUP_TUTORIAL_CONTROL_UNAVAILABLE: 'SETUP_TUTORIAL_CONTROL_UNAVAILABLE',
    SETUP_ONBOARDING_CONTROL_AMBIGUOUS: 'SETUP_ONBOARDING_CONTROL_AMBIGUOUS',
    SETUP_IMAGE_ONBOARDING_ORDER_UNEXPECTED: 'SETUP_IMAGE_ONBOARDING_ORDER_UNEXPECTED',
    SETUP_HISTORY_SHAPE_UNEXPECTED: 'SETUP_HISTORY_SHAPE_UNEXPECTED',
    SETUP_SELECTION_CLEAR_PRECONDITION_UNEXPECTED: 'SETUP_SELECTION_CLEAR_PRECONDITION_UNEXPECTED',
    SETUP_MORE_AMBIGUITY_UNEXPECTED: 'SETUP_MORE_AMBIGUITY_UNEXPECTED',
    SETUP_ESCAPE_OWNER_UNSAFE: 'SETUP_ESCAPE_OWNER_UNSAFE',
    SETUP_SELECTION_CLEAR_FAILED: 'SETUP_SELECTION_CLEAR_FAILED',
    SETUP_SELECTION_CLEAR_MEANING_CHANGED: 'SETUP_SELECTION_CLEAR_MEANING_CHANGED',
    SETUP_SELECTION_CLEAR_HISTORY_CHANGED: 'SETUP_SELECTION_CLEAR_HISTORY_CHANGED',
    SETUP_MORE_CONTROL_NOT_UNIQUE: 'SETUP_MORE_CONTROL_NOT_UNIQUE',
  });

export function setupDiagnostic(code: SetupDiagnosticCode, detail: string): DiagnosticRecord {
  return createDiagnostic(SETUP_DIAGNOSTIC_CODE[code], detail);
}

// ── Coherent pre-input ownership observation (A2) ─────────────────────────────

export interface EscapeOwnershipFacts {
  /** The created placeholder role resolves exactly once in the retained Layout. */
  createdPlaceholderResolvesOnce: boolean;
  /** That exact placeholder is the sole selected layer. */
  createdPlaceholderSoleSelection: boolean;
  /** The editor is not in entered-group child-selection mode. */
  notEnteredGroupChildSelection: boolean;
  /** Text placement, layer drag, object/image/vector placement, marquee, rename, text editing inactive. */
  noActivePlacementOrEditingMode: boolean;
  /** Focused element is not INPUT/TEXTAREA/SELECT or contenteditable. */
  focusNotEditable: boolean;
  /** No open menu, listbox, combobox, popup, command palette, help, context menu, modal, or dialog. */
  noCompetingOverlayOwner: boolean;
  /** Neither the initial tutorial nor the Image onboarding remains present. */
  noResidualOnboarding: boolean;
  /** Current route is the expected owned Artwork Editor route and no navigation is pending. */
  routeOwnedAndStable: boolean;
  /** Normalized meaning is structurally M2. */
  meaningIsM2: boolean;
  /** History is exactly H2. */
  historyIsH2: boolean;
  /** Two visible enabled global `button/More` controls, attributable to rail + placeholder toolbar. */
  moreAttribution: MoreAttributionKind;
}

export interface EscapeOwnershipVerdict {
  ok: boolean;
  failed: readonly string[];
  diagnostic: DiagnosticRecord | null;
}

/** Evaluates the coherent A2 guard; when not `ok`, no Escape may be dispatched. */
export function evaluateEscapeOwnership(facts: EscapeOwnershipFacts): EscapeOwnershipVerdict {
  const failed: string[] = [];
  if (!facts.createdPlaceholderResolvesOnce) failed.push('created-placeholder-not-unique');
  if (!facts.createdPlaceholderSoleSelection) failed.push('selection-not-sole-placeholder');
  if (!facts.notEnteredGroupChildSelection) failed.push('entered-group-child-selection');
  if (!facts.noActivePlacementOrEditingMode) failed.push('active-placement-or-editing-mode');
  if (!facts.focusNotEditable) failed.push('editable-focus');
  if (!facts.noCompetingOverlayOwner) failed.push('competing-overlay-owner');
  if (!facts.noResidualOnboarding) failed.push('residual-onboarding');
  if (!facts.routeOwnedAndStable) failed.push('route-not-owned-or-stable');
  if (!facts.meaningIsM2) failed.push('meaning-not-m2');
  if (!facts.historyIsH2) failed.push('history-not-h2');
  if (facts.moreAttribution !== 'rail+placeholder-toolbar')
    failed.push('more-not-rail-plus-toolbar');
  if (failed.length === 0) return { ok: true, failed: [], diagnostic: null };
  return {
    ok: false,
    failed,
    diagnostic: createDiagnostic(
      'SETUP_ESCAPE_OWNER_UNSAFE',
      `Escape ownership is not affirmatively established (${failed.join(', ')}); no Escape was dispatched.`,
    ),
  };
}
