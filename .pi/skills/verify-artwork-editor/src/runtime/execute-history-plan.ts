import type { Page } from '@playwright/test';

import {
  assertSetupHistoryH0H2,
  attributeMoreControls,
  evaluateEscapeOwnership,
  historyTupleMatches,
  SETUP_HISTORY_EXPECTED,
  type EscapeOwnershipFacts,
} from '../contracts/selection-clear';
import type { CaseIntent, ExecutionPlan } from '../contracts/case-model';
import { createDiagnostic, type DiagnosticRecord } from '../contracts/diagnostics';
import type { Outcome } from '../contracts/discriminants';
/**
 * Private/deprecated legacy composite check mirror (ADR 0032 §E3-S1). It is
 * retained only so this active runtime executor producer compiles until the
 * E3-S2 architecture switch consumes the additive `primitiveFacts` the History
 * Oracle exposes through `HistoryOracleEvaluation`. It is deliberately declared
 * locally (never imported from `contracts/execution`) so the producer no longer
 * reaches the legacy boolean result authority, and it is never the source of a
 * final status.
 *
 * @deprecated E3-S2 removes the legacy composite authority entirely.
 */
interface LegacyCompositeCheck {
  readonly checkId: string;
  readonly passed: boolean;
}
import type { BindingFixture } from '../contracts/fixtures';
import {
  HISTORY_ACTION_STEPS,
  HISTORY_CONTROLS,
  HISTORY_REQUIRED_CHECKS,
  HISTORY_TRANSITION_PROFILE_ID,
  INTERACTIVE_HISTORY_V1_DEADLINE_MS,
  INTERACTIVE_HISTORY_V1_TIMING_CATEGORY,
  historyTupleWithCleanEquals,
  historyWorkflowStepsAgree,
  type HistoryActionStep,
  type HistoryControlKind,
} from '../contracts/history-observation';
import type { ObservationCursor, WakeSource, WaitForChangeOutcome } from '../contracts/observation';
import type { EnvironmentCell, RunAllocation } from '../contracts/runtime';
import { OBSERVATION_GLOBAL_NAME, SETUP_GLOBAL_NAME, SETUP_ROUTE } from '../contracts/seam';
import type { WorkflowStep } from '../contracts/workflows';
import {
  clickUniqueTextRow,
  dismissInitialTutorial,
  dispatchEscapeOnce,
  observeCompetingOverlay,
  observeFocusedElement,
  observeMoreCandidates,
  observeOnboardingPopover,
  observeInitialTutorial,
  readUniqueRailMore,
} from '../browser/guarded-setup';
import { closeBrowserSession, type BrowserCloseOutcome } from '../browser/doctor';
import { openFreshPage, type BrowserSession } from '../browser/launch';
import { activateControl } from '../browser/primitives';
import {
  createSetupAuthorization,
  deliverSetupAuthorization,
  invokeSetupConstructor,
  readSetupStatus,
  type SetupConstructorOutcome,
} from '../browser/seam';
import { resolveReadinessProfile } from '../readiness/profile-registry';
import {
  evaluateHistoryOracle,
  type HistoryActionFact,
  type HistoryEvidenceFacts,
  type HistoryOracleEvaluation,
  type HistorySetupFact,
  type HistoryTupleView,
} from '../oracles/history';
import {
  type NormalizedArtworkMeaningView,
  type ProductMeaningProviderV1,
} from '../contracts/product-meaning-provider';
import type { PublicHistoryEvidenceV1 } from '../evidence/public-dto';
import { FINAL_NESTED_PROJECTION_SCHEMA_VERSION } from '../contracts/final-record-v4';
import type { MaterializedExecutionEnvelopeV1 } from '../planner/execution-materialization';
import type {
  ExecutePlanBehavior,
  FinalExecutionObservation,
  FinalExecutionPayload,
  HistoryProjectionHeader,
} from './execute-plan';
import { bindFinalActionCycleIdentity } from './action-cycle';

/**
 * Cross-subject history diagnostic drive (WP5 Slice 5-F; ADR 0019 R1–R4, R10;
 * ADR 0020 A1–A8).
 *
 * One exclusively owned server, browser, context, setup authorization, bridge
 * chain, and document. After seal the drive constructs the accepted mixed
 * precondition through seller-visible controls (Text → Image placeholder +
 * guarded Escape → Crossword), capturing the exact `M0/H0 … M3/H3` checkpoints,
 * then performs the six native toolbar Undo/Redo transitions and evaluates the
 * two binding history checks. The single normalized-meaning implementation is
 * the product-owned Node-importable core; this drive owns only orchestration and
 * classification.
 *
 * The drive is selected by the closed declarative history workflow shape, never
 * by a Subject-name, family, application-kind, scenario, or word-literal branch.
 */

export interface HistoryDriveReport {
  schemaVersion: 1;
  outcome: Extract<Outcome, 'PASS' | 'BUG' | 'HARNESS_BLOCKED'>;
  requiredChecks: readonly LegacyCompositeCheck[];
  harnessInvalid: boolean;
  diagnostics: readonly DiagnosticRecord[];
  evaluation: HistoryOracleEvaluation | null;
  /** Closed public history projection, present when all six transitions completed. */
  projection: PublicHistoryEvidenceV1 | null;
  readiness: {
    profileId: string;
    timingCategory: string;
    deadlineMs: number;
    wakeSource: WakeSource;
    fallbackPollCount: number;
    watchdogWaits: number;
    stableFrames: number;
    observedStableFrames: number;
    idle: { stableFrames: number; waitedMs: number; observationRevision: number } | null;
    timings: Readonly<Record<string, number | null>>;
  };
  detail: string;
}

export interface ExecuteHistoryPlanInput {
  allocation: RunAllocation;
  caseId: string;
  intent: CaseIntent;
  plan: ExecutionPlan;
  adapter: import('../contracts/adapter').SubjectAdapter;
  fixture: BindingFixture;
  workflowSteps: readonly WorkflowStep[];
  environment: EnvironmentCell;
  /**
   * The validated FE-owned product-meaning provider injected by Diagnostic
   * preflight (ADR 0118). It is the single normalized-meaning authority; the
   * toolkit holds no static import or fallback implementation.
   */
  meaningProvider: ProductMeaningProviderV1;
  /**
   * The exact `MaterializedExecutionEnvelopeV1` compiled once during planning.
   * The History executor places this exact object by reference in
   * `FinalExecutionObservation.envelope`; it never recompiles, looks up, or
   * reconstructs a profile.
   */
  envelope: MaterializedExecutionEnvelopeV1;
  openPage?: typeof openFreshPage;
  now?: () => number;
  /**
   * Test-only BUG/HARNESS_BLOCKED injection seam (design §10.3). It replaces the
   * control sequence and the expected tuple/meaning for the tested transitions.
   * It never changes product behaviour or normalized meaning and is unreachable
   * from a case request.
   */
  stepsOverride?: readonly HistoryActionStep[];
}

export interface ExecuteHistoryPlanResult {
  behavior: ExecutePlanBehavior;
  history: HistoryDriveReport;
  browserClose: BrowserCloseOutcome;
  environmentInvalid: boolean;
  /**
   * The exact envelope-bound final observation handoff for this executor run.
   * It is the canonical field the Diagnostic orchestration forwards; it is
   * `null` only when the family execution was never entered (a launch failure),
   * never for a drive that ran and produced malformed or unavailable authority.
   */
  finalObservation: FinalExecutionObservation | null;
}

interface HistoryLayoutItemView {
  id: string;
  isCanvas?: boolean;
  layers: Array<{ id: string; type: string }>;
}

interface HistoryBridgeSnapshotView {
  version?: number;
  route?: string;
  document: { documentId: string; documentEpoch: number };
  layoutItems: HistoryLayoutItemView[];
  activeLayoutId: string;
  selectedLayerIds: string[];
  canUndo: boolean;
  canRedo: boolean;
  history: { pastDepth: number; futureDepth: number; baselineClean: boolean };
}

interface HistoryBridgeStateView {
  snapshot: HistoryBridgeSnapshotView;
  cursor: ObservationCursor;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Structural check for one projected history Layout item. `layers` is required by
 * the view contract; the checked projection below supplies an empty array only
 * when the raw item genuinely publishes none, which the normalized-meaning
 * projection already treats identically.
 */
function isHistoryLayoutItemView(value: unknown): value is HistoryLayoutItemView {
  if (!isPlainRecord(value)) return false;
  if (typeof value.id !== 'string' || value.id.length === 0) return false;
  if (value.isCanvas !== undefined && typeof value.isCanvas !== 'boolean') return false;
  const layers = value.layers;
  if (!Array.isArray(layers)) return false;
  return layers.every(
    (layer) =>
      isPlainRecord(layer) && typeof layer.id === 'string' && typeof layer.type === 'string',
  );
}

/** Structural check for the projected history snapshot the settlement reads. */
function isHistoryBridgeSnapshotView(value: unknown): value is HistoryBridgeSnapshotView {
  if (!isPlainRecord(value)) return false;
  if (value.version !== undefined && typeof value.version !== 'number') return false;
  if (value.route !== undefined && typeof value.route !== 'string') return false;
  const document = value.document;
  if (
    !isPlainRecord(document) ||
    typeof document.documentId !== 'string' ||
    !Number.isSafeInteger(document.documentEpoch)
  ) {
    return false;
  }
  const layoutItems = value.layoutItems;
  if (!Array.isArray(layoutItems) || !layoutItems.every(isHistoryLayoutItemView)) return false;
  if (typeof value.activeLayoutId !== 'string') return false;
  const selectedLayerIds = value.selectedLayerIds;
  if (!Array.isArray(selectedLayerIds) || !selectedLayerIds.every((id) => typeof id === 'string')) {
    return false;
  }
  if (typeof value.canUndo !== 'boolean' || typeof value.canRedo !== 'boolean') return false;
  const history = value.history;
  return (
    isPlainRecord(history) &&
    typeof history.pastDepth === 'number' &&
    typeof history.futureDepth === 'number' &&
    typeof history.baselineClean === 'boolean'
  );
}

/**
 * Checked projection of one raw `bridge.state()` payload onto the exact
 * `HistoryBridgeStateView` the settlement runtime reads. The value is preserved
 * (existing fields and layer objects are not rewritten); only a layout whose raw
 * `layers` is absent receives the equivalent empty array. Malformed structure
 * returns `null`, so the caller fails closed instead of trusting a cast.
 */
export function projectHistoryBridgeStateView(raw: unknown): HistoryBridgeStateView | null {
  if (!isPlainRecord(raw) || !isPlainRecord(raw.snapshot)) return null;
  const layoutItems = raw.snapshot.layoutItems;
  if (!Array.isArray(layoutItems)) return null;
  const projectedItems: HistoryLayoutItemView[] = [];
  for (const item of layoutItems) {
    if (!isPlainRecord(item)) return null;
    const candidate: Record<string, unknown> = { ...item };
    if (candidate.layers === undefined) candidate.layers = [];
    if (!isHistoryLayoutItemView(candidate)) return null;
    projectedItems.push(candidate);
  }
  const snapshotCandidate: Record<string, unknown> = {
    ...raw.snapshot,
    layoutItems: projectedItems,
  };
  if (!isHistoryBridgeSnapshotView(snapshotCandidate)) return null;
  if (!isPlainRecord(raw.cursor)) return null;
  const cursorCandidate: Record<string, unknown> = { ...raw.cursor };
  if (!isWellFormedCursor(cursorCandidate)) return null;
  return { snapshot: snapshotCandidate, cursor: cursorCandidate };
}

interface HistoryControlFacts {
  kind: HistoryControlKind;
  accessibleName: string;
  title: string | null;
  nativeTag: string | null;
  buttonType: string | null;
  visible: boolean;
  enabled: boolean;
  matchCount: number;
}

/** True when the resolved workflow declares exactly the six history transitions. */
export function historyWorkflowMatches(steps: readonly WorkflowStep[]): boolean {
  return historyWorkflowStepsAgree(steps);
}

function bridgeStateScript(): string {
  return `(() => {
  const bridge = window[${JSON.stringify(OBSERVATION_GLOBAL_NAME)}];
  if (!bridge) return null;
  return { snapshot: bridge.snapshot(), cursor: bridge.cursor() };
})()`;
}

function bridgeWaitForChangeScript(cursor: ObservationCursor, timeoutMs: number): string {
  return `(async () => {
  const bridge = window[${JSON.stringify(OBSERVATION_GLOBAL_NAME)}];
  return await bridge.waitForChange({ after: ${JSON.stringify(cursor)}, timeoutMs: ${timeoutMs} });
})()`;
}

function bridgeWaitForIdleScript(stableFrames: number, timeoutMs: number): string {
  return `(async () => {
  const bridge = window[${JSON.stringify(OBSERVATION_GLOBAL_NAME)}];
  return await bridge.waitForIdle({ stableFrames: ${stableFrames}, timeoutMs: ${timeoutMs} });
})()`;
}

function isWellFormedCursor(value: unknown): value is ObservationCursor {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return typeof record.revision === 'number' && Number.isFinite(record.revision);
}

function sealFailure(outcome: SetupConstructorOutcome): string | null {
  if (outcome.ok) return null;
  if (outcome.outcome === 'absent') return `Setup boundary is not installed: ${outcome.detail}`;
  return `Setup refusal ${outcome.code}: ${outcome.detail}`;
}

/**
 * Projects one live bridge snapshot through the injected FE-owned provider. The
 * toolkit never owns the normalized-meaning implementation; the validated
 * provider (loaded from the explicit app root during preflight) is the single
 * authority.
 */
function meaningOf(
  snapshot: HistoryBridgeSnapshotView,
  provider: ProductMeaningProviderV1,
): NormalizedArtworkMeaningView {
  return provider.normalizeArtworkProductMeaning(snapshot);
}

function fullTuple(snapshot: HistoryBridgeSnapshotView): HistoryTupleView {
  return {
    pastDepth: snapshot.history.pastDepth,
    futureDepth: snapshot.history.futureDepth,
    baselineClean: snapshot.history.baselineClean,
  };
}

/** Reads (never dispatches) the exact native history control contract (R3). */
async function readHistoryControl(
  page: Page,
  kind: HistoryControlKind,
): Promise<HistoryControlFacts> {
  const contract = HISTORY_CONTROLS[kind];
  const locator = page.getByRole('button', { name: contract.accessibleName, exact: true });
  const all = await locator.all();
  const candidates: HistoryControlFacts[] = [];
  for (const candidate of all) {
    const [title, tagName, buttonType, visible, enabled] = await Promise.all([
      candidate.getAttribute('title'),
      candidate.evaluate((element) => element.tagName),
      candidate.getAttribute('type'),
      candidate.isVisible(),
      candidate.isEnabled(),
    ]);
    candidates.push({
      kind,
      accessibleName: contract.accessibleName,
      title,
      nativeTag: tagName,
      buttonType,
      visible,
      enabled,
      matchCount: all.length,
    });
  }
  const exact =
    candidates.find(
      (candidate) =>
        candidate.title === contract.title &&
        candidate.nativeTag === 'BUTTON' &&
        candidate.buttonType === 'button',
    ) ?? null;
  const chosen = exact ?? candidates[0] ?? null;
  if (chosen === null) {
    return {
      kind,
      accessibleName: contract.accessibleName,
      title: null,
      nativeTag: null,
      buttonType: null,
      visible: false,
      enabled: false,
      matchCount: all.length,
    };
  }
  return { ...chosen, matchCount: all.length };
}

function controlProblem(facts: HistoryControlFacts): DiagnosticRecord | null {
  const contract = HISTORY_CONTROLS[facts.kind];
  if (facts.matchCount !== 1) {
    return createDiagnostic(
      'HISTORY_CONTROL_UNAVAILABLE',
      `History control "${contract.accessibleName}" matched ${facts.matchCount} element(s); exactly one is required before dispatch.`,
    );
  }
  if (facts.nativeTag !== 'BUTTON' || facts.buttonType !== 'button') {
    return createDiagnostic(
      'HISTORY_CONTROL_UNAVAILABLE',
      `History control "${contract.accessibleName}" is not the native <button type="button"> contract (tag=${String(facts.nativeTag)}, type=${String(facts.buttonType)}).`,
    );
  }
  if (facts.title !== contract.title) {
    return createDiagnostic(
      'HISTORY_CONTROL_UNAVAILABLE',
      `History control "${contract.accessibleName}" exposes title "${String(facts.title)}", not the exact "${contract.title}".`,
    );
  }
  if (!facts.visible) {
    return createDiagnostic(
      'HISTORY_CONTROL_UNAVAILABLE',
      `History control "${contract.accessibleName}" is not visible.`,
    );
  }
  if (!facts.enabled) {
    return createDiagnostic(
      'HISTORY_CONTROL_DISABLED',
      `History control "${contract.accessibleName}" is disabled before dispatch.`,
    );
  }
  return null;
}

/** Clicks exactly one resolved native history control after the guard passes. */
async function clickHistoryControl(page: Page, kind: HistoryControlKind): Promise<void> {
  const contract = HISTORY_CONTROLS[kind];
  await page.getByRole('button', { name: contract.accessibleName, exact: true }).click();
}

interface SettledState {
  ok: boolean;
  state: HistoryBridgeStateView | null;
  wakeSource: WakeSource;
  watchdogWaits: number;
  detail: string;
}

/**
 * One non-extending quiescence cadence: up to four bounded no-change watchdogs,
 * each capped by the single remaining settlement budget (ADR 0019 R10; F2).
 */
export const HISTORY_SETTLE_WATCHDOG_ATTEMPTS = 4;
export const HISTORY_SETTLE_WATCHDOG_STEP_MS = 400;
const HISTORY_SETTLE_IDLE_STABLE_FRAMES = 3;

/** The three bridge interactions a settlement needs, injected for testability. */
export interface HistorySettleRuntime {
  waitForChange(cursor: ObservationCursor, timeoutMs: number): Promise<WaitForChangeOutcome>;
  waitForIdle(stableFrames: number, timeoutMs: number): Promise<unknown>;
  readState(): Promise<HistoryBridgeStateView | null>;
}

/** Production settlement runtime backed by the live observation bridge. */
function pageSettleRuntime(page: Page): HistorySettleRuntime {
  return {
    waitForChange: (cursor, timeoutMs) =>
      page.evaluate(bridgeWaitForChangeScript(cursor, timeoutMs)) as Promise<WaitForChangeOutcome>,
    waitForIdle: (stableFrames, timeoutMs) =>
      page.evaluate(bridgeWaitForIdleScript(stableFrames, timeoutMs)),
    readState: () => page.evaluate(bridgeStateScript()).then(projectHistoryBridgeStateView),
  };
}

/**
 * Signal-first bounded wait for a new committed history state, renderer
 * quiescence, then a bounded no-change watchdog proving the store is settled.
 *
 * F2: a single monotonic arm timestamp fixes one deadline for the whole
 * settlement. Every phase—the change waiter, the renderer idle wait, and each
 * quiescence watchdog—receives only the budget remaining at that instant, so a
 * slow waiter, a capture, or a watchdog can never extend the armed deadline.
 * The remaining budget is floored to the integer the bridge contract requires.
 * No fixed sleep, no retry.
 */
export async function settleHistory(
  runtime: HistorySettleRuntime,
  preCursor: ObservationCursor,
  deadlineMs: number,
  now: () => number,
): Promise<SettledState> {
  const armedAt = now();
  const deadlineAt = armedAt + deadlineMs;
  const remainingBudgetMs = (): number => Math.max(0, Math.floor(deadlineAt - now()));
  const expired = (phase: string, wakeSource: WakeSource, watchdogWaits: number): SettledState => ({
    ok: false,
    state: null,
    wakeSource,
    watchdogWaits,
    detail: `The single ${deadlineMs} ms history settlement deadline expired before the ${phase} phase (armed at ${armedAt} ms; ${remainingBudgetMs()} ms remained).`,
  });

  const waitBudget = remainingBudgetMs();
  if (waitBudget <= 0) return expired('change waiter', 'none', 0);
  const wake = await runtime.waitForChange(preCursor, waitBudget);
  const wakeSource: WakeSource = wake.wakeSource ?? 'store-signal';
  if (wake.status === 'invalidated') {
    return {
      ok: false,
      state: null,
      wakeSource: 'none',
      watchdogWaits: 0,
      detail: 'The observation bridge invalidated the history waiter.',
    };
  }
  if (wake.status !== 'changed') {
    return {
      ok: false,
      state: null,
      wakeSource: 'none',
      watchdogWaits: 0,
      detail: `No committed history transition was observed within the ${waitBudget} ms remaining budget (waitForChange="${wake.status}").`,
    };
  }
  const idleBudget = remainingBudgetMs();
  if (idleBudget <= 0) return expired('renderer idle', wakeSource, 0);
  await runtime.waitForIdle(HISTORY_SETTLE_IDLE_STABLE_FRAMES, idleBudget);
  let settled = await runtime.readState();
  if (settled === null || !isWellFormedCursor(settled.cursor)) {
    return {
      ok: false,
      state: null,
      wakeSource,
      watchdogWaits: 0,
      detail: 'The settled history state was unreadable or its cursor was malformed.',
    };
  }
  let watchdogWaits = 0;
  while (watchdogWaits < HISTORY_SETTLE_WATCHDOG_ATTEMPTS) {
    const watchdogBudget = remainingBudgetMs();
    if (watchdogBudget <= 0) return expired('quiescence watchdog', wakeSource, watchdogWaits);
    const watchdog = await runtime.waitForChange(
      settled.cursor,
      Math.min(HISTORY_SETTLE_WATCHDOG_STEP_MS, watchdogBudget),
    );
    watchdogWaits += 1;
    if (watchdog.status === 'timeout') {
      return {
        ok: true,
        state: settled,
        wakeSource,
        watchdogWaits,
        detail: 'Accepted a settled committed history state.',
      };
    }
    if (watchdog.status !== 'changed') {
      return {
        ok: false,
        state: null,
        wakeSource: 'none',
        watchdogWaits,
        detail: `The store quiescence watchdog was invalidated ("${watchdog.status}").`,
      };
    }
    settled = await runtime.readState();
    if (settled === null) {
      return {
        ok: false,
        state: null,
        wakeSource,
        watchdogWaits,
        detail: 'The store changed again after the accepted transition and became unreadable.',
      };
    }
  }
  return {
    ok: false,
    state: null,
    wakeSource,
    watchdogWaits,
    detail:
      'The store did not reach a settled state within the bounded non-extending quiescence watchdog.',
  };
}

export async function executeHistoryPlan(
  input: ExecuteHistoryPlanInput,
): Promise<ExecuteHistoryPlanResult> {
  const steps = input.stepsOverride ?? HISTORY_ACTION_STEPS;
  const provider = input.meaningProvider;
  const now = input.now ?? (() => performance.now());
  const registration = resolveReadinessProfile(HISTORY_TRANSITION_PROFILE_ID);
  const profileDeadline = registration?.profile.deadlineMs ?? INTERACTIVE_HISTORY_V1_DEADLINE_MS;
  const stableFrames = registration?.profile.stableFrames ?? 3;
  const oracleProfileId = (registration?.oracleProfileId ??
    'history-cross-subject-v1') as 'history-cross-subject-v1';

  const diagnostics: DiagnosticRecord[] = [];
  const timings: Record<string, number | null> = {};
  const setupFacts: HistorySetupFact[] = [];
  const actionFacts: HistoryActionFact[] = [];
  const checkpointCanonical = new Map<string, string>();
  const checkpointMeaning = new Map<string, NormalizedArtworkMeaningView>();

  let harnessInvalid = false;
  let bugObserved = false;
  let detail = 'History drive did not complete.';
  let observedStableFrames = 0;
  let lastWakeSource: WakeSource = 'none';
  let watchdogWaits = 0;
  let lastIdle: HistoryDriveReport['readiness']['idle'] = null;
  let retainedLayoutId = '';
  let finalHistory: HistoryTupleView = { pastDepth: 0, futureDepth: 0, baselineClean: true };
  let evaluation: HistoryOracleEvaluation | null = null;
  let projection: PublicHistoryEvidenceV1 | null = null;
  let requiredChecks: readonly LegacyCompositeCheck[] = HISTORY_REQUIRED_CHECKS.map((checkId) => ({
    checkId,
    passed: false,
  }));
  let session: BrowserSession | null = null;
  let browserClose: BrowserCloseOutcome = { closed: true, detail: null };
  let environmentInvalid = false;
  let finalObservation: FinalExecutionObservation | null = null;
  /**
   * True once this drive has entered family execution (the owned page opened
   * and the setup/bridge seam was reached). A launch failure keeps it `false`,
   * so the handoff stays `null`; every post-launch terminal — including
   * malformed or unavailable authority — binds a non-null observation.
   */
  let familyExecutionEntered = false;

  /**
   * Assembles the immutable, envelope-bound History final observation from the
   * raw withheld primitives currently in scope and retains the exact planning
   * envelope by reference. It reads no legacy composite `checks`, `passed`,
   * `harnessInvalid`, `requiredSourcesAgree`, or behavior outcome. It is called
   * at every post-launch terminal, so a drive that captured facts but failed a
   * check still hands over an explicit malformed/unavailable primitive view.
   */
  const bindHistoryObservation = (): void => {
    const actionCycleId = `final:${input.allocation.runId}:${input.caseId}:history-cross-subject`;
    const authority = evaluation === null ? 'malformed' : evaluation.primitiveFacts.authority;
    const payload: FinalExecutionPayload = {
      evaluatorKind: 'history-cross-subject',
      projection: buildHistoryProjectionHeader({
        profileDeadlineMs: profileDeadline,
        oracleProfileId,
        retainedLayoutId,
        finalHistory,
        evaluation,
        actionCycleRef: actionCycleId,
      }),
      retainedLayoutId: retainedLayoutId.length === 0 ? null : retainedLayoutId,
      setup: [...setupFacts],
      actions: [...actionFacts],
      finalHistory,
      readiness: {
        policy: historyReadinessPolicy(input.envelope),
        observation: {
          outcome: historyReadinessOutcome(lastWakeSource),
          wakeSource: lastWakeSource,
          fallbackPollCount: 0,
          watchdogWaits,
          observedStableFrames: observedStableFrames === 0 ? null : observedStableFrames,
          detail: null,
        },
      },
      oracle:
        evaluation === null
          ? null
          : {
              primitiveFacts: evaluation.primitiveFacts,
              diagnostics: evaluation.diagnostics,
            },
      evidence: historyEvidenceFacts(
        input.envelope.correctnessProfile.requiredAuthoritativeEvidence,
        authority,
      ),
    };
    finalObservation = Object.freeze({
      envelope: input.envelope,
      actionCycle: bindFinalActionCycleIdentity({ envelope: input.envelope, actionCycleId }),
      payload: Object.freeze(payload),
      observationId: actionFacts[actionFacts.length - 1]?.observationId ?? null,
    });
  };

  const historyReport = (
    outcome: Extract<Outcome, 'PASS' | 'BUG' | 'HARNESS_BLOCKED'>,
  ): HistoryDriveReport => ({
    schemaVersion: 1,
    outcome,
    requiredChecks,
    harnessInvalid,
    diagnostics,
    evaluation,
    projection,
    readiness: {
      profileId: HISTORY_TRANSITION_PROFILE_ID,
      timingCategory: INTERACTIVE_HISTORY_V1_TIMING_CATEGORY,
      deadlineMs: profileDeadline,
      wakeSource: lastWakeSource,
      fallbackPollCount: 0,
      watchdogWaits,
      stableFrames,
      observedStableFrames,
      idle: lastIdle,
      timings,
    },
    detail,
  });

  const behaviorFor = (
    outcome: Extract<Outcome, 'PASS' | 'BUG' | 'HARNESS_BLOCKED'>,
  ): ExecutePlanBehavior => ({
    outcome,
    requiredChecks,
    requiredSourcesAgree: !harnessInvalid,
    harnessInvalid,
    diagnostics,
    resolutions: [],
    targetIds: [],
    preBehaviorRefusal: null,
    seal: null,
    bridgeContract: null,
    action: null,
    actionLogs: [],
    cycle: null,
    observation: null,
    oracleInputs: null,
    wakeSource: lastWakeSource,
    fallbackPollCount: 0,
    profile: {
      readinessProfileId: HISTORY_TRANSITION_PROFILE_ID,
      readinessDeadlineMs: profileDeadline,
      readinessStableFrames: stableFrames,
      readinessTimingCategory: INTERACTIVE_HISTORY_V1_TIMING_CATEGORY,
      oracleProfileId,
    },
    timings,
    detail,
  });

  const blocked = (): ExecuteHistoryPlanResult => {
    // A launch failure never entered family execution, so the handoff stays
    // `null`; every post-launch terminal binds an explicit observation.
    if (familyExecutionEntered) bindHistoryObservation();
    return {
      behavior: behaviorFor('HARNESS_BLOCKED'),
      history: historyReport('HARNESS_BLOCKED'),
      browserClose,
      environmentInvalid,
      finalObservation,
    };
  };

  try {
    session = await (input.openPage ?? openFreshPage)({
      baseUrl: input.allocation.baseUrl,
      route: SETUP_ROUTE,
      environment: input.environment,
      navigationTimeoutMs: 60_000,
    });
    familyExecutionEntered = true;
    const { page } = session;
    const settleRuntime = pageSettleRuntime(page);

    await page.waitForFunction(
      (name) => Boolean((window as unknown as Record<string, unknown>)[name]),
      OBSERVATION_GLOBAL_NAME,
      { timeout: 30_000 },
    );
    await page.waitForFunction(
      (name) => Boolean((window as unknown as Record<string, unknown>)[name]),
      SETUP_GLOBAL_NAME,
      { timeout: 30_000 },
    );

    // ── Seal the accepted two-layout Text constructor (no setup credit).
    const status = await readSetupStatus(page);
    if (status === null) {
      harnessInvalid = true;
      diagnostics.push(
        createDiagnostic('UNUSABLE_EVIDENCE', 'The setup boundary status was unavailable.'),
      );
      detail = 'Setup status unavailable.';
      return blocked();
    }
    const authorization = createSetupAuthorization({
      runId: input.allocation.runId,
      caseId: input.caseId,
      origin: new URL(input.allocation.baseUrl).origin,
      documentId: status.document.documentId,
    });
    await deliverSetupAuthorization(page, authorization);
    const constructed = await invokeSetupConstructor(page, {
      constructorId: input.fixture.constructorId,
      constructorVersion: input.fixture.constructorVersion,
      scope: { runId: input.allocation.runId, caseId: input.caseId },
      inputs: input.fixture.inputs as unknown as Record<string, unknown>,
    });
    const sealProblem = sealFailure(constructed);
    if (sealProblem !== null) {
      harnessInvalid = true;
      diagnostics.push(createDiagnostic('SETUP_HYDRATE_REJECTED', sealProblem));
      detail = `Constructor refused: ${sealProblem}`;
      return blocked();
    }
    if (!constructed.ok) {
      harnessInvalid = true;
      detail = 'The setup constructor did not seal.';
      return blocked();
    }
    retainedLayoutId = constructed.sealRecord.semanticPrecondition.activeLayoutId;

    const recordCheckpoint = (
      checkpointId: 'H0' | 'H1' | 'H2' | 'H3',
      role: string,
      meaning: 'M0' | 'M1' | 'M2' | 'M3',
      snapshot: HistoryBridgeSnapshotView,
    ): void => {
      const normalized = meaningOf(snapshot, provider);
      const canonical = provider.canonicalizeNormalizedMeaning(normalized);
      checkpointCanonical.set(meaning, canonical);
      checkpointMeaning.set(meaning, normalized);
      setupFacts.push({
        checkpointId,
        meaning,
        pastDepth: snapshot.history.pastDepth,
        futureDepth: snapshot.history.futureDepth,
        baselineClean: snapshot.history.baselineClean,
        meaningFingerprint: provider.fingerprintNormalizedMeaning(normalized),
        role,
      });
    };

    const initial = (await page.evaluate(bridgeStateScript())) as HistoryBridgeStateView | null;
    if (initial === null || !isWellFormedCursor(initial.cursor)) {
      harnessInvalid = true;
      diagnostics.push(
        createDiagnostic('UNUSABLE_EVIDENCE', 'The sealed baseline observation was unreadable.'),
      );
      detail = 'Sealed baseline unreadable.';
      return blocked();
    }
    if (
      initial.snapshot.history.pastDepth !== 0 ||
      initial.snapshot.history.futureDepth !== 0 ||
      initial.snapshot.history.baselineClean !== true
    ) {
      harnessInvalid = true;
      diagnostics.push(
        createDiagnostic(
          'SETUP_HISTORY_SHAPE_UNEXPECTED',
          `The sealed baseline was not the exact clean H0 tuple (past=${initial.snapshot.history.pastDepth}, future=${initial.snapshot.history.futureDepth}).`,
        ),
      );
      detail = 'Sealed baseline was not clean H0.';
      return blocked();
    }
    recordCheckpoint('H0', 'sealed-host', 'M0', initial.snapshot);

    // ── A1: optional initial tutorial, dismissed with no effect.
    const tutorialBefore = await observeInitialTutorial(page);
    const dismiss = await dismissInitialTutorial(page);
    if (tutorialBefore.present && !dismiss.dismissed) {
      harnessInvalid = true;
      diagnostics.push(createDiagnostic('SETUP_TUTORIAL_CONTROL_UNAVAILABLE', dismiss.detail));
      detail = 'Initial tutorial blocked setup.';
      return blocked();
    }

    // ── Setup 1: Text.
    if (!(await activateControl({ page, accessibleName: 'Text' })).ok) {
      harnessInvalid = true;
      diagnostics.push(
        createDiagnostic('SETUP_HISTORY_SHAPE_UNEXPECTED', 'The Text tool was not actionable.'),
      );
      detail = 'Text tool unavailable.';
      return blocked();
    }
    const preText = (await page.evaluate(bridgeStateScript())) as HistoryBridgeStateView;
    if (!(await activateControl({ page, accessibleName: 'Add text' })).ok) {
      harnessInvalid = true;
      diagnostics.push(
        createDiagnostic(
          'SETUP_HISTORY_SHAPE_UNEXPECTED',
          'The Add text control was not actionable.',
        ),
      );
      detail = 'Add text unavailable.';
      return blocked();
    }
    let settled = await settleHistory(settleRuntime, preText.cursor, profileDeadline, now);
    lastWakeSource = settled.wakeSource;
    watchdogWaits += settled.watchdogWaits;
    if (!settled.ok || settled.state === null) {
      harnessInvalid = true;
      diagnostics.push(createDiagnostic('SETUP_HISTORY_SHAPE_UNEXPECTED', settled.detail));
      detail = settled.detail;
      return blocked();
    }
    recordCheckpoint('H1', 'created-text', 'M1', settled.state.snapshot);

    // ── Setup 2: Image placeholder with phase-owned onboarding (A1).
    if (!(await activateControl({ page, accessibleName: 'Image' })).ok) {
      harnessInvalid = true;
      diagnostics.push(
        createDiagnostic('SETUP_HISTORY_SHAPE_UNEXPECTED', 'The Image tool was not actionable.'),
      );
      detail = 'Image tool unavailable.';
      return blocked();
    }
    const row = await clickUniqueTextRow(page, 'Add image placeholder');
    if (!row.ok) {
      harnessInvalid = true;
      diagnostics.push(createDiagnostic('SETUP_IMAGE_ONBOARDING_ORDER_UNEXPECTED', row.detail));
      detail = 'Add image placeholder row was not uniquely actionable.';
      return blocked();
    }
    await page.waitForFunction(
      `(() => {
        const nodes = Array.from(document.querySelectorAll('p, span, h1, h2, h3, h4'));
        return nodes.some((node) => node.offsetParent !== null && (node.textContent || '').trim() === 'Image placeholder');
      })()`,
      undefined,
      { timeout: 10_000 },
    );
    const beforeGotIt = (await page.evaluate(bridgeStateScript())) as HistoryBridgeStateView;
    const onboarding = await observeOnboardingPopover(page, 'Image placeholder');
    if (onboarding.present && onboarding.gotItActionable !== 1) {
      harnessInvalid = true;
      diagnostics.push(
        createDiagnostic(
          'SETUP_ONBOARDING_CONTROL_AMBIGUOUS',
          `${onboarding.gotItActionable} actionable "Got it" controls; exactly one is required.`,
        ),
      );
      detail = 'Image onboarding control ambiguous.';
      return blocked();
    }
    if (onboarding.present && !(await activateControl({ page, accessibleName: 'Got it' })).ok) {
      harnessInvalid = true;
      diagnostics.push(
        createDiagnostic(
          'SETUP_ONBOARDING_CONTROL_AMBIGUOUS',
          'The phase-owned Image onboarding "Got it" was not actionable.',
        ),
      );
      detail = 'Image onboarding Got it unavailable.';
      return blocked();
    }
    settled = await settleHistory(settleRuntime, beforeGotIt.cursor, profileDeadline, now);
    lastWakeSource = settled.wakeSource;
    watchdogWaits += settled.watchdogWaits;
    if (!settled.ok || settled.state === null) {
      harnessInvalid = true;
      diagnostics.push(createDiagnostic('SETUP_HISTORY_SHAPE_UNEXPECTED', settled.detail));
      detail = settled.detail;
      return blocked();
    }
    recordCheckpoint('H2', 'created-image-placeholder', 'M2', settled.state.snapshot);

    // ── A2/A3/A4: one guarded native Escape before resolving More.
    const preEscape = (await page.evaluate(bridgeStateScript())) as HistoryBridgeStateView;
    const selectedBefore = [...preEscape.snapshot.selectedLayerIds];
    const moreBefore = attributeMoreControls(await observeMoreCandidates(page));
    const focus = await observeFocusedElement(page);
    const overlay = await observeCompetingOverlay(page);
    const residualOnboarding = await observeOnboardingPopover(page, 'Image placeholder');
    const ownershipFacts: EscapeOwnershipFacts = {
      createdPlaceholderResolvesOnce: selectedBefore.length === 1,
      createdPlaceholderSoleSelection: selectedBefore.length === 1,
      notEnteredGroupChildSelection: true,
      noActivePlacementOrEditingMode: !focus.isEditableTarget,
      focusNotEditable: !focus.isEditableTarget,
      noCompetingOverlayOwner: !overlay.anyOpen,
      noResidualOnboarding: !residualOnboarding.present,
      routeOwnedAndStable: page.url().includes('/artwork/editor'),
      meaningIsM2: true,
      historyIsH2: historyTupleMatches(
        {
          pastDepth: preEscape.snapshot.history.pastDepth,
          futureDepth: preEscape.snapshot.history.futureDepth,
        },
        SETUP_HISTORY_EXPECTED.H2,
      ),
      moreAttribution: moreBefore.kind,
    };
    const ownership = evaluateEscapeOwnership(ownershipFacts);
    if (!ownership.ok) {
      harnessInvalid = true;
      diagnostics.push(
        createDiagnostic(
          'SETUP_ESCAPE_OWNER_UNSAFE',
          `Escape ownership was unsafe: ${ownership.failed.join(', ')}.`,
        ),
      );
      detail = 'Guarded Escape ownership was not established.';
      return blocked();
    }
    const escapeDispatch = await dispatchEscapeOnce(page);
    if (escapeDispatch.escapeDispatchCount !== 1) {
      harnessInvalid = true;
      diagnostics.push(
        createDiagnostic('SETUP_ESCAPE_OWNER_UNSAFE', 'Exactly one Escape must be dispatched.'),
      );
      detail = 'Escape dispatch count was not one.';
      return blocked();
    }
    const postEscape = (await page.evaluate(bridgeStateScript())) as HistoryBridgeStateView;
    const moreAfter = attributeMoreControls(await observeMoreCandidates(page));
    const railMore = await readUniqueRailMore(page);
    if (
      postEscape.snapshot.selectedLayerIds.length !== 0 ||
      moreAfter.actionableCount !== 1 ||
      moreAfter.kind !== 'single-rail' ||
      railMore === null
    ) {
      harnessInvalid = true;
      diagnostics.push(
        createDiagnostic(
          'SETUP_SELECTION_CLEAR_FAILED',
          'One Escape did not clear selection and leave the unique rail More.',
        ),
      );
      detail = 'Guarded selection clear failed.';
      return blocked();
    }
    if (
      provider.canonicalizeNormalizedMeaning(meaningOf(postEscape.snapshot, provider)) !==
        checkpointCanonical.get('M2') ||
      !historyTupleMatches(
        {
          pastDepth: postEscape.snapshot.history.pastDepth,
          futureDepth: postEscape.snapshot.history.futureDepth,
        },
        SETUP_HISTORY_EXPECTED.H2,
      )
    ) {
      harnessInvalid = true;
      diagnostics.push(
        createDiagnostic(
          'SETUP_SELECTION_CLEAR_MEANING_CHANGED',
          'The guarded Escape changed history or product meaning.',
        ),
      );
      detail = 'Guarded Escape changed meaning or history.';
      return blocked();
    }

    // ── Setup 3: More → Crossword.
    if (!(await activateControl({ page, accessibleName: 'More' })).ok) {
      harnessInvalid = true;
      diagnostics.push(
        createDiagnostic(
          'SETUP_MORE_CONTROL_NOT_UNIQUE',
          'The rail More control was not uniquely actionable.',
        ),
      );
      detail = 'Rail More unavailable.';
      return blocked();
    }
    if (!(await activateControl({ page, accessibleName: 'Crossword' })).ok) {
      harnessInvalid = true;
      diagnostics.push(
        createDiagnostic(
          'SETUP_HISTORY_SHAPE_UNEXPECTED',
          'The native Crossword control was not actionable.',
        ),
      );
      detail = 'Crossword control unavailable.';
      return blocked();
    }
    settled = await settleHistory(settleRuntime, postEscape.cursor, profileDeadline, now);
    lastWakeSource = settled.wakeSource;
    watchdogWaits += settled.watchdogWaits;
    if (!settled.ok || settled.state === null) {
      harnessInvalid = true;
      diagnostics.push(createDiagnostic('SETUP_HISTORY_SHAPE_UNEXPECTED', settled.detail));
      detail = settled.detail;
      return blocked();
    }
    recordCheckpoint('H3', 'created-crossword', 'M3', settled.state.snapshot);

    // Exact authored setup history 0/1/2/3 before any tested transition.
    const setupProblem = assertSetupHistoryH0H2(
      setupFacts.slice(0, 3).map((fact) => ({
        pastDepth: fact.pastDepth,
        futureDepth: fact.futureDepth,
      })),
    );
    if (
      setupProblem !== null ||
      setupFacts[3]?.pastDepth !== SETUP_HISTORY_EXPECTED.H3.pastDepth ||
      setupFacts[3]?.futureDepth !== SETUP_HISTORY_EXPECTED.H3.futureDepth
    ) {
      harnessInvalid = true;
      diagnostics.push(
        setupProblem ??
          createDiagnostic('SETUP_HISTORY_SHAPE_UNEXPECTED', 'H3 was not the exact 3/0 tuple.'),
      );
      detail = 'Setup history was not exactly 0/1/2/3.';
      return blocked();
    }

    // ── The tested native toolbar Undo/Redo transitions (R3/R4).
    for (const step of steps) {
      const started = now();
      const before = (await page.evaluate(bridgeStateScript())) as HistoryBridgeStateView | null;
      if (before === null || !isWellFormedCursor(before.cursor)) {
        harnessInvalid = true;
        diagnostics.push(
          createDiagnostic(
            'UNUSABLE_EVIDENCE',
            `Step ${step.stepIndex} pre-action state was unreadable.`,
          ),
        );
        detail = `Step ${step.stepIndex} pre-action state unreadable.`;
        timings[step.stepId] = now() - started;
        return blocked();
      }
      const controlFacts = await readHistoryControl(page, step.control);
      const problem = controlProblem(controlFacts);
      if (problem !== null) {
        harnessInvalid = true;
        diagnostics.push(problem);
        detail = `Step ${step.stepIndex} blocked before dispatch: ${problem.detail}`;
        timings[step.stepId] = now() - started;
        return blocked();
      }
      await clickHistoryControl(page, step.control);
      const stepSettled = await settleHistory(settleRuntime, before.cursor, profileDeadline, now);
      timings[step.stepId] = now() - started;
      lastWakeSource = stepSettled.wakeSource;
      watchdogWaits += stepSettled.watchdogWaits;
      if (!stepSettled.ok || stepSettled.state === null) {
        harnessInvalid = true;
        diagnostics.push(
          createDiagnostic(
            'HISTORY_TRANSITION_MISSING',
            `Step ${step.stepIndex}: ${stepSettled.detail}`,
          ),
        );
        detail = `Step ${step.stepIndex} produced no accepted transition: ${stepSettled.detail}`;
        return blocked();
      }
      const after = stepSettled.state;
      observedStableFrames = stableFrames;
      lastIdle = { stableFrames, waitedMs: 0, observationRevision: after.cursor.revision };
      const expectedHistory: HistoryTupleView = {
        pastDepth: step.expectedHistory.pastDepth,
        futureDepth: step.expectedHistory.futureDepth,
        // The declared product-exact positional baseline (F1): every
        // post-Undo/Redo state is `baselineClean: false`, never hardcoded true.
        baselineClean: step.expectedHistory.baselineClean,
      };
      const afterTuple = fullTuple(after.snapshot);
      const expectedMeaning = checkpointMeaning.get(step.expectedMeaning) ?? null;
      const actualMeaning = meaningOf(after.snapshot, provider);
      const actualCanonical = provider.canonicalizeNormalizedMeaning(actualMeaning);
      const meaningStructurallyEqual =
        expectedMeaning !== null &&
        actualCanonical === provider.canonicalizeNormalizedMeaning(expectedMeaning);
      const transitionObserved = after.cursor.revision > before.cursor.revision;
      const historyTupleExact = historyTupleWithCleanEquals(afterTuple, expectedHistory);
      if (!historyTupleExact || !meaningStructurallyEqual || !transitionObserved) {
        bugObserved = true;
      }
      actionFacts.push({
        stepIndex: step.stepIndex,
        stepId: step.stepId,
        control: step.control,
        controlAccessibleName: controlFacts.accessibleName,
        controlTitle: controlFacts.title ?? '',
        controlNativeTag: controlFacts.nativeTag ?? '',
        controlButtonType: controlFacts.buttonType,
        controlVisible: controlFacts.visible,
        controlEnabledBeforeDispatch: controlFacts.enabled,
        dispatchCount: 1,
        preActionRevision: before.cursor.revision,
        postActionRevision: after.cursor.revision,
        historyBefore: fullTuple(before.snapshot),
        historyAfter: afterTuple,
        expectedHistory,
        historyTupleExact,
        expectedMeaning: step.expectedMeaning,
        meaningFingerprint: provider.fingerprintNormalizedMeaning(actualMeaning),
        expectedMeaningFingerprint:
          expectedMeaning === null
            ? null
            : provider.fingerprintNormalizedMeaning(expectedMeaning),
        meaningStructurallyEqual,
        observationId: `history:${step.stepId}:${after.cursor.revision}`,
        idle: lastIdle,
        tornRecaptureCount: 0,
        transitionObserved,
      });
      finalHistory = afterTuple;
    }

    const facts: HistoryEvidenceFacts = {
      retainedLayoutId,
      setup: setupFacts,
      actions: actionFacts,
      finalHistory,
    };
    evaluation = evaluateHistoryOracle(facts, HISTORY_REQUIRED_CHECKS);
    diagnostics.push(...evaluation.diagnostics);
    requiredChecks = evaluation.checks;
    const outcome: Extract<Outcome, 'PASS' | 'BUG' | 'HARNESS_BLOCKED'> = evaluation.harnessInvalid
      ? 'HARNESS_BLOCKED'
      : bugObserved || !evaluation.passed
        ? 'BUG'
        : 'PASS';
    if (outcome === 'HARNESS_BLOCKED') {
      harnessInvalid = true;
    }
    detail =
      outcome === 'PASS'
        ? 'All six native Undo/Redo transitions produced the exact required history tuple and normalized product meaning.'
        : 'A native Undo/Redo transition produced a wrong history tuple or restored meaning.';
    // The closed public projection asserts the exact accepted tuples/meanings,
    // so it is written only for an accepted PASS. A BUG records its honest
    // failing required checks and diagnostics with a null projection.
    if (outcome === 'PASS') {
      projection = {
        schemaVersion: 1,
        normalizationProfileId: 'artwork-product-meaning-v1',
        readinessProfileId: HISTORY_TRANSITION_PROFILE_ID,
        oracleProfileId,
        timingCategory: INTERACTIVE_HISTORY_V1_TIMING_CATEGORY,
        deadlineMs: 5000,
        retainedLayoutId,
        setup: setupFacts.map((fact) => ({
          checkpointId: fact.checkpointId as 'H0' | 'H1' | 'H2' | 'H3',
          role: fact.role,
          pastDepth: fact.pastDepth,
          futureDepth: fact.futureDepth,
          baselineClean: fact.baselineClean,
          meaning: fact.meaning as 'M0' | 'M1' | 'M2' | 'M3',
          meaningFingerprint: fact.meaningFingerprint,
        })),
        actions: actionFacts.map((fact) => ({
          actionEpochId: `history:${fact.stepId}:${fact.preActionRevision}`,
          stepIndex: fact.stepIndex,
          stepId: fact.stepId,
          control: fact.control,
          controlAccessibleName: fact.controlAccessibleName,
          controlTitle: fact.controlTitle,
          controlNativeTag: fact.controlNativeTag,
          controlButtonType: fact.controlButtonType,
          controlVisible: fact.controlVisible,
          controlEnabledBeforeDispatch: fact.controlEnabledBeforeDispatch,
          dispatchCount: 1 as const,
          preActionRevision: fact.preActionRevision,
          postActionRevision: fact.postActionRevision,
          historyBefore: fact.historyBefore,
          historyAfter: fact.historyAfter,
          expectedHistory: fact.expectedHistory,
          historyTupleExact: fact.historyTupleExact,
          expectedMeaning: fact.expectedMeaning,
          meaningFingerprint: fact.meaningFingerprint,
          expectedMeaningFingerprint: fact.expectedMeaningFingerprint,
          meaningStructurallyEqual: fact.meaningStructurallyEqual,
          observationId: fact.observationId,
          idle: fact.idle,
          tornRecaptureCount: 0,
          transitionObserved: fact.transitionObserved,
        })),
        finalHistory,
        checks: evaluation.checks.map((check) => ({
          checkId: check.checkId,
          passed: check.passed,
          evidenceIds: actionFacts
            .map((fact) => fact.observationId)
            .filter((id): id is string => id !== null)
            .map((id) => `observation:${id}`),
        })),
      };
    }
    bindHistoryObservation();
    return {
      behavior: behaviorFor(outcome),
      history: historyReport(outcome),
      browserClose,
      environmentInvalid,
      finalObservation,
    };
  } catch (error) {
    environmentInvalid = true;
    detail = `History drive failed during owned execution: ${(error as Error).message}`;
    return blocked();
  } finally {
    if (session) {
      browserClose = await closeBrowserSession(session);
      session = null;
    }
  }
}

/**
 * The accepted History final payload variant, derived from the single
 * `FinalExecutionPayload` union so this executor imports no adapter/kernel type.
 */
type HistoryFinalPayload = Extract<
  FinalExecutionPayload,
  { evaluatorKind: 'history-cross-subject' }
>;

/**
 * The compiled readiness policy view the accepted history chain applied. It is
 * copied from the exact planning envelope, which is the only policy authority;
 * a divergent runtime constant would be a contract disagreement.
 */
interface HistoryReadinessPolicyView {
  readonly profileId: string;
  readonly deadlineCategory: string;
  readonly deadlineMs: number;
  readonly signalWatchdogMs: number;
  readonly fallbackCadenceMs: readonly number[];
  readonly stableFrames: number;
  readonly quiescenceRequired: boolean;
  readonly stableFrameRequired: boolean;
}

/**
 * Projects every declared required-authoritative evidence id with its actual
 * availability. A `current` Oracle primitive authority yields `authoritative`;
 * an absent or malformed authority yields `malformed`. No evidence id is
 * invented and no legacy composite check is read.
 */
function historyEvidenceFacts(
  evidenceIds: readonly string[],
  authority: 'current' | 'malformed',
): HistoryFinalPayload['evidence'] {
  const availability = authority === 'current' ? 'authoritative' : 'malformed';
  return evidenceIds.map((evidenceId) => ({ evidenceId, availability }));
}

/**
 * Copies the compiled readiness policy from the exact planning envelope. The
 * envelope is the only authority; a divergent runtime constant would be a
 * contract disagreement, so no runtime profile literal is used here.
 */
function historyReadinessPolicy(
  envelope: MaterializedExecutionEnvelopeV1,
): HistoryReadinessPolicyView {
  const readiness = envelope.correctnessProfile.readiness;
  return {
    profileId: readiness.profileId,
    deadlineCategory: readiness.deadlineCategory,
    deadlineMs: readiness.deadlineMs,
    signalWatchdogMs: readiness.signalWatchdogMs,
    fallbackCadenceMs: [...readiness.fallbackCadenceMs],
    stableFrames: readiness.stableFrames,
    quiescenceRequired: readiness.quiescenceRequired,
    stableFrameRequired: readiness.stableFrameRequired,
  };
}

/**
 * Projects the delivered chain wake source onto the closed readiness-outcome
 * vocabulary. A chain that was never woken (`none`) reports `unavailable`; an
 * observed signal-first wake reports `signal`.
 */
function historyReadinessOutcome(wakeSource: WakeSource): 'signal' | 'unavailable' {
  return wakeSource === 'none' ? 'unavailable' : 'signal';
}

/**
 * Builds the existing check-free History nested-projection header from the
 * accepted whole-document chain the executor actually captured; the final
 * façade attaches the evaluated checks. It is `null` whenever the accepted
 * chain or retained target is unavailable, so an incomplete drive never
 * fabricates a projection. No legacy check or aggregate flag is read.
 */
function buildHistoryProjectionHeader(input: {
  readonly profileDeadlineMs: number;
  readonly oracleProfileId: string;
  readonly retainedLayoutId: string;
  readonly finalHistory: HistoryTupleView;
  readonly evaluation: HistoryOracleEvaluation | null;
  readonly actionCycleRef: string;
}): HistoryProjectionHeader | null {
  if (input.evaluation === null || input.retainedLayoutId.length === 0) return null;
  return {
    schemaVersion: FINAL_NESTED_PROJECTION_SCHEMA_VERSION,
    family: 'history',
    normalizationProfileId: 'artwork-product-meaning-v1',
    readinessProfileId: HISTORY_TRANSITION_PROFILE_ID,
    oracleProfileId: input.oracleProfileId,
    timingCategory: INTERACTIVE_HISTORY_V1_TIMING_CATEGORY,
    deadlineMs: input.profileDeadlineMs,
    retainedLayoutId: input.retainedLayoutId,
    finalHistory: input.finalHistory,
    actionCycleRef: input.actionCycleRef,
  };
}
