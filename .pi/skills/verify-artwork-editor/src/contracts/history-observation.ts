/**
 * Cross-subject history observation contract (WP5 Slice 5-F; ADR 0019 R3/R4).
 *
 * This module is pure closed data. It names the exact native control contract,
 * the exact six-transition setup/undo/redo shape, the honest browser-keyboard
 * primitive for the guarded selection clear, and the closed readiness/Oracle
 * profile identities. It contains no DOM, store, bridge, or Product access.
 *
 * It is the single source of truth for the history drive and for the durable
 * run-record v3 history projection, so the evidence writer and the runtime can
 * never disagree about the expected tuples or control names.
 */

/** Schema of the closed history observation/evidence projection. */
export const HISTORY_OBSERVATION_SCHEMA_VERSION = 1;

/** Product-owned normalized-meaning profile consumed by the history Oracle. */
export const HISTORY_NORMALIZATION_PROFILE_ID = 'artwork-product-meaning-v1';

/** Signal-first readiness profile for one native Undo/Redo toolbar transition. */
export const HISTORY_TRANSITION_PROFILE_ID = 'history-transition-v1';

/** History Oracle profile. */
export const HISTORY_ORACLE_PROFILE_ID = 'history-cross-subject-v1';

/** Timing category of the shared history transition profile. */
export const INTERACTIVE_HISTORY_V1_TIMING_CATEGORY = 'INTERACTIVE_HISTORY_V1';

/** One non-extending per-Undo/Redo deadline (ADR 0019 R10). */
export const INTERACTIVE_HISTORY_V1_DEADLINE_MS = 5_000;

/** Full-document capability: the profile is not target-aware. */
export const HISTORY_TRANSITION_TARGET_AWARE = false;

/**
 * Exact seller-visible Undo/Redo control contract (ADR 0019 R3): role `button`,
 * exact accessible name, exact matching title, native `<button type="button">`,
 * visible and enabled before dispatch, exactly one match.
 */
export const HISTORY_CONTROLS = Object.freeze({
  undo: Object.freeze({
    kind: 'undo',
    accessibleName: 'Undo (\u2318Z)',
    title: 'Undo (\u2318Z)',
  }),
  redo: Object.freeze({
    kind: 'redo',
    accessibleName: 'Redo (\u2318\u21e7Z)',
    title: 'Redo (\u2318\u21e7Z)',
  }),
} as const);

export type HistoryControlKind = keyof typeof HISTORY_CONTROLS;

/** Native element contract for every tested history control. */
export const HISTORY_CONTROL_NATIVE_TAG = 'BUTTON';
export const HISTORY_CONTROL_BUTTON_TYPE = 'button';

/** The six exact setup checkpoints (`H0`…`H3`) and their meanings (`M0`…`M3`). */
export const HISTORY_SETUP_CHECKPOINTS = Object.freeze([
  Object.freeze({
    checkpointId: 'H0',
    role: 'sealed-host',
    pastDepth: 0,
    futureDepth: 0,
    meaning: 'M0',
  }),
  Object.freeze({
    checkpointId: 'H1',
    role: 'created-text',
    pastDepth: 1,
    futureDepth: 0,
    meaning: 'M1',
  }),
  Object.freeze({
    checkpointId: 'H2',
    role: 'created-image-placeholder',
    pastDepth: 2,
    futureDepth: 0,
    meaning: 'M2',
  }),
  Object.freeze({
    checkpointId: 'H3',
    role: 'created-crossword',
    pastDepth: 3,
    futureDepth: 0,
    meaning: 'M3',
  }),
] as const);

/** Exact `H3` tuple the six transitions start from. */
export const HISTORY_SETUP_H3 = Object.freeze({ pastDepth: 3, futureDepth: 0 });

export type HistoryCheckpointMeaning = 'M0' | 'M1' | 'M2' | 'M3';

export interface HistoryExpectedTuple {
  pastDepth: number;
  futureDepth: number;
  /**
   * Product-exact positional `baselineClean` for the expected tuple. It is
   * `pastDepth === 0 && futureDepth === 0`, so every post-Undo/Redo state is
   * `false` (F1). It is declared here, never hardcoded at the call site.
   */
  baselineClean: boolean;
}

export interface HistoryActionStep {
  stepIndex: number;
  stepId: string;
  control: HistoryControlKind;
  expectedHistory: HistoryExpectedTuple;
  expectedMeaning: HistoryCheckpointMeaning;
}

/**
 * The exact six-transition invariant. Each row is one separate Action Cycle with
 * its own `historyActionEpochId`.
 */
export const HISTORY_ACTION_STEPS = Object.freeze([
  Object.freeze({
    stepIndex: 0,
    stepId: 'history.undo-1',
    control: 'undo',
    expectedHistory: Object.freeze({ pastDepth: 2, futureDepth: 1, baselineClean: false }),
    expectedMeaning: 'M2',
  }),
  Object.freeze({
    stepIndex: 1,
    stepId: 'history.undo-2',
    control: 'undo',
    expectedHistory: Object.freeze({ pastDepth: 1, futureDepth: 2, baselineClean: false }),
    expectedMeaning: 'M1',
  }),
  Object.freeze({
    stepIndex: 2,
    stepId: 'history.undo-3',
    control: 'undo',
    expectedHistory: Object.freeze({ pastDepth: 0, futureDepth: 3, baselineClean: false }),
    expectedMeaning: 'M0',
  }),
  Object.freeze({
    stepIndex: 3,
    stepId: 'history.redo-1',
    control: 'redo',
    expectedHistory: Object.freeze({ pastDepth: 1, futureDepth: 2, baselineClean: false }),
    expectedMeaning: 'M1',
  }),
  Object.freeze({
    stepIndex: 4,
    stepId: 'history.redo-2',
    control: 'redo',
    expectedHistory: Object.freeze({ pastDepth: 2, futureDepth: 1, baselineClean: false }),
    expectedMeaning: 'M2',
  }),
  Object.freeze({
    stepIndex: 5,
    stepId: 'history.redo-3',
    control: 'redo',
    expectedHistory: Object.freeze({ pastDepth: 3, futureDepth: 0, baselineClean: false }),
    expectedMeaning: 'M3',
  }),
] as const satisfies readonly HistoryActionStep[]);

/** The two required history checks (binding-declared). */
export const HISTORY_REQUIRED_CHECKS = Object.freeze(['history.depth', 'history.meaning'] as const);
export type HistoryRequiredCheckId = (typeof HISTORY_REQUIRED_CHECKS)[number];

export interface HistoryTuple {
  pastDepth: number;
  futureDepth: number;
}

export interface HistoryTupleWithClean extends HistoryTuple {
  baselineClean: boolean;
}

/** Exact tuple comparison; there is no "greater than previous" fallback. */
export function historyTupleEquals(actual: HistoryTuple, expected: HistoryTuple): boolean {
  return actual.pastDepth === expected.pastDepth && actual.futureDepth === expected.futureDepth;
}

/** Product-exact positional `baselineClean`: only the 0/0 tuple is the clean baseline. */
export function productBaselineClean(pastDepth: number, futureDepth: number): boolean {
  return pastDepth === 0 && futureDepth === 0;
}

/**
 * Exact tuple comparison including the product positional `baselineClean` (F1).
 * A depth match with a contradictory or hardcoded `baselineClean` is not an
 * exact match.
 */
export function historyTupleWithCleanEquals(
  actual: HistoryTupleWithClean,
  expected: HistoryTupleWithClean,
): boolean {
  return (
    actual.pastDepth === expected.pastDepth &&
    actual.futureDepth === expected.futureDepth &&
    actual.baselineClean === expected.baselineClean
  );
}

/** The declared workflow steps must be exactly the six history transitions. */
export function historyWorkflowStepsAgree(
  steps: readonly { stepId: string; targetRole: string }[],
): boolean {
  if (steps.length !== HISTORY_ACTION_STEPS.length) return false;
  return HISTORY_ACTION_STEPS.every((expected, index) => {
    const actual = steps[index];
    if (actual === undefined) return false;
    const role = expected.control === 'undo' ? 'control:history-undo' : 'control:history-redo';
    return actual.stepId === expected.stepId && actual.targetRole === role;
  });
}

/** Human-readable exact control name for a kind. */
export function historyControlName(kind: HistoryControlKind): string {
  return HISTORY_CONTROLS[kind].accessibleName;
}

/** The checkpoint meaning for a setup checkpoint id, or `null`. */
export function historySetupMeaning(checkpointId: string): HistoryCheckpointMeaning | null {
  return (
    HISTORY_SETUP_CHECKPOINTS.find((entry) => entry.checkpointId === checkpointId)?.meaning ?? null
  );
}
