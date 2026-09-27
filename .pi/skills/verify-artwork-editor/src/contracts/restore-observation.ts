/**
 * Frontend serialize/restore observation contract (WP5 Slice 5-F; ADR 0019
 * R5–R7, R9; ADR 0021 N1/N7).
 *
 * This module is pure closed data. It names the seller-visible Save contract,
 * the closed readiness/Oracle profile identities, the two binding required
 * checks, the declared setup recipes that build the source document through
 * visible product controls, and the exact evidence facts the restore Oracle
 * consumes. It contains no DOM, store, bridge, network, or Product access.
 *
 * The setup recipes are keyed by the *declared fixture role name*, so a case's
 * source construction is catalogue data routed through a closed recipe
 * registry — never an engine branch on Subject, application kind, scenario, or
 * variant. The drive imports the product-owned normalized-meaning core
 * directly (ADR 0021 N7); the toolkit never maintains a second normalizer.
 */

/** Schema of the closed restore observation/evidence projection. */
export const RESTORE_OBSERVATION_SCHEMA_VERSION = 1;

/** Product-owned normalized-meaning profile consumed by the restore Oracle. */
export const RESTORE_NORMALIZATION_PROFILE_ID = 'artwork-product-meaning-v1';

/** Signal-first readiness profile for the Save → POST → redirect → GET → mount chain. */
export const RESTORE_TRANSITION_PROFILE_ID = 'frontend-restore-transition-v1';

/** Restore Oracle profile. */
export const RESTORE_ORACLE_PROFILE_ID = 'frontend-restore-v1';

/** Timing category of the single non-extending full-restore deadline. */
export const FRONTEND_RESTORE_V1_TIMING_CATEGORY = 'FRONTEND_RESTORE_V1';

/**
 * One monotonic, non-extending 15,000 ms deadline covering click → POST →
 * redirect → GET → bridge mount → idle → coherent restored capture (ADR 0019
 * R5/R9). Progress cannot extend it and it never resets.
 */
export const FRONTEND_RESTORE_V1_DEADLINE_MS = 15_000;

/** Full-document capability: the profile is not target-aware. */
export const RESTORE_TRANSITION_TARGET_AWARE = false;

/**
 * Exact seller-visible Save control contract. The product renders one native
 * `<button type="button">` with accessible name `Save` (its text becomes
 * `Saving…` only while the mutation is pending). Duplicate, inaccessible, or
 * disabled Save controls block before dispatch.
 */
export const RESTORE_SAVE_CONTROL = Object.freeze({
  accessibleName: 'Save',
});

/** The two binding required restore checks. */
export const RESTORE_REQUIRED_CHECKS = Object.freeze([
  'serialize.raw-semantic',
  'serialize.roundtrip',
] as const);
export type RestoreRequiredCheckId = (typeof RESTORE_REQUIRED_CHECKS)[number];

/** The two declared restore scenarios (Coverage Model release-required). */
export const RESTORE_SCENARIOS = Object.freeze({
  roundtrip: 'serialize-roundtrip',
  rawSemantic: 'serialize-raw-semantic',
} as const);
export type RestoreScenarioId = (typeof RESTORE_SCENARIOS)[keyof typeof RESTORE_SCENARIOS];

// ── Declared source construction ─────────────────────────────────────────────

/**
 * Closed vocabulary of seller-visible setup actions. Each action names an exact
 * product control; none carries a coordinate, script, sleep, or predicate.
 */
export const RESTORE_SETUP_ACTION_PRIMITIVES = [
  'control.activate',
  'row.click',
  'onboarding.got-it',
  'selection.clear',
] as const;
export type RestoreSetupActionPrimitive = (typeof RESTORE_SETUP_ACTION_PRIMITIVES)[number];

export interface RestoreSetupAction {
  primitive: RestoreSetupActionPrimitive;
  /** Exact accessible name for `control.activate` and the row text for `row.click`. */
  accessibleName?: string;
  /** Exact visible text of the onboarding anchor for `onboarding.got-it`. */
  text?: string;
}

export interface RestoreSetupRecipe {
  role: string;
  actions: readonly RestoreSetupAction[];
}

/**
 * Closed setup-recipe registry keyed by declared fixture role name. A fixture
 * role whose name is not a declared recipe cannot build a source document and
 * blocks before any input.
 */
export const RESTORE_SETUP_RECIPES: Readonly<Record<string, RestoreSetupRecipe>> = Object.freeze({
  'setup-text': Object.freeze({
    role: 'setup-text',
    actions: Object.freeze([
      Object.freeze({ primitive: 'control.activate', accessibleName: 'Text' }),
      Object.freeze({ primitive: 'control.activate', accessibleName: 'Add text' }),
    ]),
  }),
  'setup-image-placeholder': Object.freeze({
    role: 'setup-image-placeholder',
    actions: Object.freeze([
      Object.freeze({ primitive: 'control.activate', accessibleName: 'Image' }),
      Object.freeze({ primitive: 'row.click', accessibleName: 'Add image placeholder' }),
      Object.freeze({ primitive: 'onboarding.got-it', text: 'Image placeholder' }),
    ]),
  }),
  'setup-crossword': Object.freeze({
    role: 'setup-crossword',
    actions: Object.freeze([
      Object.freeze({ primitive: 'selection.clear' }),
      Object.freeze({ primitive: 'control.activate', accessibleName: 'More' }),
      Object.freeze({ primitive: 'control.activate', accessibleName: 'Crossword' }),
    ]),
  }),
});

/** Resolves the declared setup recipe for one fixture role name, or `null`. */
export function resolveRestoreSetupRecipe(role: string): RestoreSetupRecipe | null {
  return Object.hasOwn(RESTORE_SETUP_RECIPES, role)
    ? (RESTORE_SETUP_RECIPES[role] as RestoreSetupRecipe)
    : null;
}

/** The declared setup recipe order derived from a fixture's declared role names. */
export function restoreSetupRecipesForRoles(
  roles: readonly { role: string }[],
): readonly RestoreSetupRecipe[] {
  return roles.map((entry) => resolveRestoreSetupRecipe(entry.role)).filter((r) => r !== null);
}

// ── Exact route contract ─────────────────────────────────────────────────────

/** The exact create endpoint the product serializer targets through `Save`. */
export const RESTORE_CREATE_PATH = '/api/artwork/create';
export const RESTORE_CREATE_METHOD = 'POST';
export const RESTORE_CREATE_CONTENT_TYPE = 'application/json';

/** The exact post-save product redirect target. */
export const RESTORE_REDIRECT_PATH = '/artwork';

/** The exact restored editor route prefix, `<id>` appended for the deterministic id. */
export const RESTORE_EDITOR_ROUTE_PREFIX = '/artwork/editor/';

/** Deterministic server artwork id the case-owned route adapter assigns. */
export const RESTORE_DETERMINISTIC_ARTWORK_ID = 424242;

/** Deterministic server layout id base the case-owned route adapter assigns. */
export const RESTORE_DETERMINISTIC_LAYOUT_ID_BASE = 900000;

/** Deterministic server layer id base the case-owned route adapter assigns. */
export const RESTORE_DETERMINISTIC_LAYER_ID_BASE = 700000;

/** Exact deterministic response envelope message. */
export const RESTORE_RESPONSE_MESSAGE = 'OK';

/** Exact deterministic response envelope timestamp. */
export const RESTORE_RESPONSE_TIMESTAMP = '2026-01-01T00:00:00.000Z';

/**
 * The closed restore workflow step contract: one `control.activate` step over
 * `control:save`, followed by the closed runtime handoff
 * `frontend.restore.capture`. The handoff step accepts no URL, body, or
 * expected value — it is a declarative marker that the drive selects this
 * closed workflow, never executable case code.
 */
export const RESTORE_WORKFLOW_STEP_IDS = ['serialize.save', 'serialize.restore.capture'] as const;

/** The declared workflow steps must be exactly the Save + closed handoff. */
export function restoreWorkflowStepsAgree(
  steps: readonly { stepId: string; primitive: string; targetRole: string }[],
): boolean {
  if (steps.length !== RESTORE_WORKFLOW_STEP_IDS.length) return false;
  const [save, capture] = steps;
  if (save === undefined || capture === undefined) return false;
  return (
    save.stepId === 'serialize.save' &&
    save.primitive === 'control.activate' &&
    save.targetRole === 'control:save' &&
    capture.stepId === 'serialize.restore.capture' &&
    capture.primitive === 'frontend.restore.capture' &&
    capture.targetRole === 'frontend:restore'
  );
}

// ── Oracle fact views ────────────────────────────────────────────────────────

export interface RestoreTransitionFactView {
  saveDispatchedOnce: boolean;
  createRequestCount: number;
  createMethodMatches: boolean;
  createPathMatches: boolean;
  createContentTypeMatches: boolean;
  createAfterEpoch: boolean;
  getRequestCount: number;
  getMethodMatches: boolean;
  getPathMatches: boolean;
  redirectObserved: boolean;
  navigateRouteMatches: boolean;
  documentIdentityDistinct: boolean;
  restoredHistoryClean: boolean;
  harnessHydrateCalls: 0;
  harnessStoreMutationCalls: 0;
}

export interface RestoreMeaningFactView {
  normalizedStructurallyEqual: boolean;
  normalizedFingerprintEqual: boolean;
  sourceFingerprint: string | null;
  restoredFingerprint: string | null;
  /** No included semantic inventory was lost across the round trip. */
  inventoryPreserved: boolean;
  /** A raw difference between source and restored that is not explained by an exclusion. */
  persistenceLossDetected: boolean;
}

export interface RestoreRawSemanticFactView {
  crosswordPresent: boolean;
  generationSeed: number | null;
  words: readonly string[];
  layoutDigest: string | null;
  restoredSeedMatches: boolean;
  restoredWordsMatch: boolean;
  restoredLayoutDigestMatches: boolean;
  rawConfigPresent: boolean;
  rawServerMetadataPresent: boolean;
  normalizedHasNoIdKey: boolean;
  normalizedHasNoConfigKey: boolean;
  normalizedHasNoServerMetadata: boolean;
  volatileIdsDiffer: boolean;
}

export interface RestoreOracleFacts {
  schemaVersion: 1;
  requiredChecks: readonly string[];
  transition: RestoreTransitionFactView;
  meaning: RestoreMeaningFactView;
  rawSemantics: RestoreRawSemanticFactView;
}

/** True when a fully valid restore transition produced the required semantics. */
export function restoreTransitionSatisfied(fact: RestoreTransitionFactView): boolean {
  return (
    fact.saveDispatchedOnce &&
    fact.createRequestCount === 1 &&
    fact.createMethodMatches &&
    fact.createPathMatches &&
    fact.createContentTypeMatches &&
    fact.createAfterEpoch &&
    fact.getRequestCount === 1 &&
    fact.getMethodMatches &&
    fact.getPathMatches &&
    fact.redirectObserved &&
    fact.navigateRouteMatches &&
    fact.documentIdentityDistinct &&
    fact.restoredHistoryClean &&
    fact.harnessHydrateCalls === 0 &&
    fact.harnessStoreMutationCalls === 0
  );
}

/** True when the normalized round trip is exact and no persistence loss is detected. */
export function restoreMeaningSatisfied(fact: RestoreMeaningFactView): boolean {
  return (
    fact.normalizedStructurallyEqual &&
    fact.normalizedFingerprintEqual &&
    fact.sourceFingerprint !== null &&
    fact.sourceFingerprint === fact.restoredFingerprint &&
    fact.inventoryPreserved &&
    !fact.persistenceLossDetected
  );
}

/** True when raw Crossword/config/server-metadata checks pass separately. */
export function restoreRawSemanticSatisfied(fact: RestoreRawSemanticFactView): boolean {
  const crosswordExact = fact.crosswordPresent
    ? fact.generationSeed !== null &&
      fact.layoutDigest !== null &&
      fact.restoredSeedMatches &&
      fact.restoredWordsMatch &&
      fact.restoredLayoutDigestMatches
    : true;
  return (
    crosswordExact &&
    fact.rawConfigPresent &&
    fact.rawServerMetadataPresent &&
    fact.normalizedHasNoIdKey &&
    fact.normalizedHasNoConfigKey &&
    fact.normalizedHasNoServerMetadata &&
    fact.volatileIdsDiffer
  );
}
