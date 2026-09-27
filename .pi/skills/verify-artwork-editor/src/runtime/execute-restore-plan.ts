import type { Page, Request, Route } from '@playwright/test';

import type { CaseIntent, ExecutionPlan } from '../contracts/case-model';
import { createDiagnostic, type DiagnosticRecord } from '../contracts/diagnostics';
import type { Outcome } from '../contracts/discriminants';
/**
 * Private/deprecated legacy composite check mirror (ADR 0032 §E3-S1). It is
 * retained only so this active runtime executor producer compiles until the
 * E3-S2 architecture switch consumes the additive `primitiveFacts` the Restore
 * Oracle exposes through `RestoreOracleEvaluation`. It is deliberately declared
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
import type { ObservationCursor, WakeSource, WaitForChangeOutcome } from '../contracts/observation';
import type { EnvironmentCell, RunAllocation } from '../contracts/runtime';
import { OBSERVATION_GLOBAL_NAME, SETUP_GLOBAL_NAME, SETUP_ROUTE } from '../contracts/seam';
import {
  RESTORE_CREATE_CONTENT_TYPE,
  RESTORE_CREATE_METHOD,
  RESTORE_CREATE_PATH,
  RESTORE_DETERMINISTIC_ARTWORK_ID,
  RESTORE_DETERMINISTIC_LAYER_ID_BASE,
  RESTORE_DETERMINISTIC_LAYOUT_ID_BASE,
  RESTORE_EDITOR_ROUTE_PREFIX,
  RESTORE_OBSERVATION_SCHEMA_VERSION,
  RESTORE_ORACLE_PROFILE_ID,
  RESTORE_REDIRECT_PATH,
  RESTORE_REQUIRED_CHECKS,
  RESTORE_RESPONSE_MESSAGE,
  RESTORE_RESPONSE_TIMESTAMP,
  RESTORE_SAVE_CONTROL,
  RESTORE_TRANSITION_PROFILE_ID,
  FRONTEND_RESTORE_V1_DEADLINE_MS,
  FRONTEND_RESTORE_V1_TIMING_CATEGORY,
  resolveRestoreSetupRecipe,
  restoreWorkflowStepsAgree,
  type RestoreMeaningFactView,
  type RestoreOracleFacts,
  type RestoreRawSemanticFactView,
  type RestoreSetupRecipe,
  type RestoreTransitionFactView,
} from '../contracts/restore-observation';
import type { WorkflowStep } from '../contracts/workflows';
import type { EscapeOwnershipFacts } from '../contracts/selection-clear';
import { attributeMoreControls, evaluateEscapeOwnership } from '../contracts/selection-clear';
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
  type NormalizedArtworkMeaningView,
  type ProductMeaningProviderV1,
} from '../contracts/product-meaning-provider';
import { sha256Hex } from '../canonical/canonicalize';
import type { PublicRestoreEvidenceV1 } from '../evidence/public-dto';
import { evaluateRestoreOracle, type RestoreOracleEvaluation } from '../oracles/restore';
import { FINAL_NESTED_PROJECTION_SCHEMA_VERSION } from '../contracts/final-record-v4';
import type { MaterializedExecutionEnvelopeV1 } from '../planner/execution-materialization';
import {
  projectHistoryBridgeStateView,
  settleHistory,
  type HistorySettleRuntime,
} from './execute-history-plan';
import type {
  ExecutePlanBehavior,
  FinalExecutionObservation,
  FinalExecutionPayload,
  RestoreProjectionHeader,
} from './execute-plan';
import { bindFinalActionCycleIdentity } from './action-cycle';

/**
 * Frontend serialize/restore diagnostic drive (WP5 Slice 5-F; ADR 0019 R5–R7/R9;
 * ADR 0021 N7).
 *
 * One exclusively owned server, browser, context, setup authorization, bridge
 * chain, and — for the restore step — one deterministic same-origin route
 * fulfillment. After seal the drive builds the declared source document through
 * the exact seller-visible controls named by the fixture's closed setup recipes,
 * captures a coherent source meaning, performs the real seller Save (capturing
 * the exact `POST /api/artwork/create` body), follows the product redirect,
 * opens `/artwork/editor/<id>`, fulfills the exact `GET /api/artwork/<id>`, and
 * lets the real product restorer mount a fresh document with a clean history
 * baseline. It then evaluates normalized structural equality and the raw
 * Crossword/config/server-metadata checks.
 *
 * The claim is frontend-only: deterministic route fulfillment proves frontend
 * serialization, transport consumption, and frontend restoration — never
 * backend validation, persistence, durability, authorization, or identity.
 *
 * The drive is selected by the closed declarative restore workflow shape, never
 * by a Subject-name, family, application-kind, scenario, or word-literal branch.
 */

export interface RestoreDriveReport {
  schemaVersion: 1;
  outcome: Extract<Outcome, 'PASS' | 'BUG' | 'HARNESS_BLOCKED'>;
  requiredChecks: readonly LegacyCompositeCheck[];
  harnessInvalid: boolean;
  diagnostics: readonly DiagnosticRecord[];
  evaluation: RestoreOracleEvaluation | null;
  /** Closed public restore projection, present only when the round trip passed. */
  projection: PublicRestoreEvidenceV1 | null;
  readiness: {
    profileId: string;
    timingCategory: string;
    deadlineMs: number;
    wakeSource: WakeSource;
    fallbackPollCount: number;
    watchdogWaits: number;
    stableFrames: number;
    observedStableFrames: number;
    timings: Readonly<Record<string, number | null>>;
  };
  detail: string;
}

export interface ExecuteRestorePlanInput {
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
   * The Restore executor places this exact object by reference in
   * `FinalExecutionObservation.envelope`; it never recompiles, looks up, or
   * reconstructs a profile.
   */
  envelope: MaterializedExecutionEnvelopeV1;
  openPage?: typeof openFreshPage;
  now?: () => number;
  /**
   * Test-only BUG/HARNESS_BLOCKED injection seam. It can rewrite the deterministic
   * response semantics or make a required route/control unavailable. It never
   * changes product behaviour, normalized meaning, or the closed route contract.
   */
  failureMode?:
    | { kind: 'mutate-response'; mutate: (response: Record<string, unknown>) => void }
    | { kind: 'malformed-response' }
    | { kind: 'disable-save' };
}

export interface ExecuteRestorePlanResult {
  behavior: ExecutePlanBehavior;
  restore: RestoreDriveReport;
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

interface BridgeSnapshotView {
  version?: number;
  route?: string;
  document: { documentId: string; documentEpoch: number };
  layoutItems: unknown[];
  activeLayoutId: string;
  selectedLayerIds: string[];
  canUndo: boolean;
  canRedo: boolean;
  history: { pastDepth: number; futureDepth: number; baselineClean: boolean };
}

interface BridgeStateView {
  snapshot: BridgeSnapshotView;
  cursor: ObservationCursor;
}

interface TypedCrosswordView {
  generationSeed: number;
  words: string[];
  layout: unknown;
}

interface SetupCheckpointView {
  role: string;
  stepCount: number;
  historyPastDepth: number;
  historyFutureDepth: number;
  historyBaselineClean: boolean;
  meaningFingerprint: string;
  canonical: string;
}

/** True when the resolved workflow declares exactly the Save + closed handoff. */
export function restoreWorkflowMatches(steps: readonly WorkflowStep[]): boolean {
  return restoreWorkflowStepsAgree(steps);
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

function meaningOf(
  snapshot: BridgeSnapshotView,
  provider: ProductMeaningProviderV1,
): NormalizedArtworkMeaningView {
  return provider.normalizeArtworkProductMeaning(snapshot);
}

function hasKeyInCanonical(canonical: string, key: string): boolean {
  return canonical.includes(`"${key}":`);
}

/**
 * Finds the first typed Crossword semantic model in a snapshot's `layoutItems`.
 * The constructor fixture contains no Crossword, so the only match is the layer
 * the declared setup recipe created through the visible `More → Crossword`
 * control.
 */
function typedCrosswordOf(snapshot: BridgeSnapshotView): TypedCrosswordView | null {
  for (const item of snapshot.layoutItems) {
    const layers = (item as { layers?: unknown }).layers;
    if (!Array.isArray(layers)) continue;
    for (const layer of layers) {
      const crossword = (layer as { crossword?: unknown } | null)?.crossword;
      if (crossword === null || typeof crossword !== 'object' || Array.isArray(crossword)) continue;
      const record = crossword as Record<string, unknown>;
      if (typeof record.generationSeed !== 'number' || !Number.isFinite(record.generationSeed)) {
        continue;
      }
      if (!Array.isArray(record.words) || !record.words.every((word) => typeof word === 'string')) {
        continue;
      }
      if (record.layout === null || typeof record.layout !== 'object') continue;
      return {
        generationSeed: record.generationSeed,
        words: [...(record.words as string[])],
        layout: record.layout,
      };
    }
  }
  return null;
}

function idsOf(snapshot: BridgeSnapshotView): { layouts: string[]; layers: string[] } {
  const layouts: string[] = [];
  const layers: string[] = [];
  for (const item of snapshot.layoutItems) {
    const record = item as { id?: unknown; isCanvas?: unknown; layers?: unknown };
    if (record.isCanvas === true) continue;
    if (typeof record.id === 'string') layouts.push(record.id);
    if (!Array.isArray(record.layers)) continue;
    for (const layer of record.layers) {
      const id = (layer as { id?: unknown } | null)?.id;
      if (typeof id === 'string') layers.push(id);
    }
  }
  return { layouts, layers };
}

function layerCountOf(snapshot: BridgeSnapshotView): { layouts: number; layers: number } {
  let layouts = 0;
  let layers = 0;
  for (const item of snapshot.layoutItems) {
    const record = item as { isCanvas?: unknown; layers?: unknown };
    if (record.isCanvas === true) continue;
    layouts += 1;
    if (Array.isArray(record.layers)) layers += record.layers.length;
  }
  return { layouts, layers };
}

const RESTORE_CROSSWORD_LAYOUT_DOMAIN = 'makeit:restore-crossword-layout:v1';

function crossWordLayoutDigest(layout: unknown, provider: ProductMeaningProviderV1): string {
  return sha256Hex(
    `${RESTORE_CROSSWORD_LAYOUT_DOMAIN}\0${provider.canonicalizeNormalizedMeaning(layout)}`,
  );
}

function sameWords(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((word, index) => word === right[index]);
}

/**
 * Converts the real captured `CreateArtworkDto` bytes into a deterministic
 * `ArtworkResponseDto`. It only assigns server identity/metadata and copies the
 * semantic payload bytes verbatim; it performs no normalization and no
 * expected-result logic.
 */
function buildDeterministicResponse(body: Record<string, unknown>): Record<string, unknown> {
  const layouts = Array.isArray(body.layouts) ? (body.layouts as Record<string, unknown>[]) : [];
  let layerCounter = 0;
  const responseLayouts = layouts.map((layout, layoutIndex) => {
    const layoutId = RESTORE_DETERMINISTIC_LAYOUT_ID_BASE + layoutIndex;
    const rawLayers = Array.isArray(layout.layers)
      ? (layout.layers as Record<string, unknown>[])
      : [];
    const layers = rawLayers.map((layer) => {
      layerCounter += 1;
      return {
        ...layer,
        id: RESTORE_DETERMINISTIC_LAYER_ID_BASE + layerCounter,
        ownerType: 'LAYOUT',
        ownerId: layoutId,
      };
    });
    return {
      id: layoutId,
      name: typeof layout.name === 'string' ? layout.name : `Layout ${layoutIndex + 1}`,
      artworkId: RESTORE_DETERMINISTIC_ARTWORK_ID,
      createdAt: RESTORE_RESPONSE_TIMESTAMP,
      updatedAt: RESTORE_RESPONSE_TIMESTAMP,
      layers,
    };
  });
  return {
    data: {
      id: RESTORE_DETERMINISTIC_ARTWORK_ID,
      shopId: 1,
      type: 'ARTWORK',
      name: typeof body.name === 'string' ? body.name : 'Untitled Artwork',
      renderOrder: 0,
      visible: true,
      locked: false,
      createdAt: RESTORE_RESPONSE_TIMESTAMP,
      updatedAt: RESTORE_RESPONSE_TIMESTAMP,
      layouts: responseLayouts,
    },
    message: RESTORE_RESPONSE_MESSAGE,
    timestamp: RESTORE_RESPONSE_TIMESTAMP,
  };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, detail: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(detail)), Math.max(1, timeoutMs));
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function makeDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

interface RouteLedger {
  createCount: number;
  getCount: number;
  undeclaredCount: number;
  duplicateDenied: boolean;
  createMethodMatch: boolean;
  createContentTypeMatch: boolean;
  createAfterEpoch: boolean;
  getMethodMatch: boolean;
  getPathMatch: boolean;
  getPath: string;
  capturedBody: Record<string, unknown> | null;
  capturedBodyText: string;
  response: Record<string, unknown> | null;
  malformedResponseDelivered: boolean;
}

/**
 * The accepted Restore final payload variant, derived from the single
 * `FinalExecutionPayload` union so this executor imports no adapter/kernel type.
 */
type RestoreFinalPayload = Extract<FinalExecutionPayload, { evaluatorKind: 'frontend-restore' }>;

/**
 * The compiled readiness policy view the accepted whole-document round trip
 * applied. It is copied from the exact planning envelope, which is the only
 * policy authority; a divergent runtime constant would be a contract
 * disagreement.
 */
interface RestoreReadinessPolicyView {
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
function restoreEvidenceFacts(
  evidenceIds: readonly string[],
  authority: 'current' | 'malformed',
): RestoreFinalPayload['evidence'] {
  const availability = authority === 'current' ? 'authoritative' : 'malformed';
  return evidenceIds.map((evidenceId) => ({ evidenceId, availability }));
}

/**
 * Copies the compiled readiness policy from the exact planning envelope. The
 * envelope is the only authority; a divergent runtime constant would be a
 * contract disagreement, so no runtime profile literal is used here.
 */
function restoreReadinessPolicy(
  envelope: MaterializedExecutionEnvelopeV1,
): RestoreReadinessPolicyView {
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
 * Projects the delivered round-trip wake source onto the closed readiness-outcome
 * vocabulary. A chain that was never woken (`none`) reports `unavailable`; an
 * observed signal-first wake reports `signal`.
 */
function restoreReadinessOutcome(wakeSource: WakeSource): 'signal' | 'unavailable' {
  return wakeSource === 'none' ? 'unavailable' : 'signal';
}

/** The closed scenario discriminant the accepted restore projection names. */
function restoreScenarioId(fixture: BindingFixture): string {
  return fixture.scenarioId === 'serialize-raw-semantic'
    ? 'serialize-raw-semantic'
    : 'serialize-roundtrip';
}

/**
 * Builds the accepted coherent source or restored document observation from the
 * exact bridge snapshot and cursor the drive captured. The optional editor-only
 * `activeLayoutId`/`selectedLayerIds` are copied from the same snapshot and are
 * never fabricated.
 */
function restoreDocumentObservation(input: {
  readonly documentId: string;
  readonly documentEpoch: number;
  readonly route: string;
  readonly observationId: string;
  readonly observationRevision: number;
  readonly bridgeGeneration: number;
  readonly normalizedFingerprint: string;
  readonly canonicalDigest: string;
  readonly layoutCount: number;
  readonly layerCount: number;
  readonly historyPastDepth: number;
  readonly historyFutureDepth: number;
  readonly historyBaselineClean: boolean;
  readonly activeLayoutId: string;
  readonly selectedLayerIds: readonly string[];
}): unknown {
  return { ...input };
}

/**
 * Builds the existing check-free Restore nested-projection header from the
 * accepted round trip the executor actually captured; the final façade attaches
 * the evaluated checks. It is `null` whenever the accepted round trip or either
 * document identity is unavailable, so an incomplete drive never fabricates a
 * projection. No legacy check or aggregate flag is read.
 */
function buildRestoreProjectionHeader(input: {
  readonly profileDeadlineMs: number;
  readonly oracleProfileId: string;
  readonly scenarioId: string;
  readonly sourceDocumentId: string;
  readonly restoredDocumentId: string;
  readonly evaluation: RestoreOracleEvaluation | null;
  readonly actionCycleRef: string;
}): RestoreProjectionHeader | null {
  if (
    input.evaluation === null ||
    input.sourceDocumentId.length === 0 ||
    input.restoredDocumentId.length === 0
  ) {
    return null;
  }
  return {
    schemaVersion: FINAL_NESTED_PROJECTION_SCHEMA_VERSION,
    family: 'restore',
    normalizationProfileId: 'artwork-product-meaning-v1',
    readinessProfileId: RESTORE_TRANSITION_PROFILE_ID,
    oracleProfileId: input.oracleProfileId,
    timingCategory: FRONTEND_RESTORE_V1_TIMING_CATEGORY,
    deadlineMs: input.profileDeadlineMs,
    scenarioId: input.scenarioId,
    sourceDocumentId: input.sourceDocumentId,
    restoredDocumentId: input.restoredDocumentId,
    actionCycleRef: input.actionCycleRef,
  };
}

export async function executeRestorePlan(
  input: ExecuteRestorePlanInput,
): Promise<ExecuteRestorePlanResult> {
  const now = input.now ?? (() => performance.now());
  const provider = input.meaningProvider;
  const registration = resolveReadinessProfile(RESTORE_TRANSITION_PROFILE_ID);
  const profileDeadline = registration?.profile.deadlineMs ?? FRONTEND_RESTORE_V1_DEADLINE_MS;
  const stableFrames = registration?.profile.stableFrames ?? 3;
  const oracleProfileId = registration?.oracleProfileId ?? RESTORE_ORACLE_PROFILE_ID;

  const diagnostics: DiagnosticRecord[] = [];
  const timings: Record<string, number | null> = {};
  const setupCheckpoints: SetupCheckpointView[] = [];
  let harnessInvalid = false;
  const bugObserved = false;
  let detail = 'Restore drive did not complete.';
  let observedStableFrames = 0;
  let lastWakeSource: WakeSource = 'none';
  let watchdogWaits = 0;
  let evaluation: RestoreOracleEvaluation | null = null;
  let projection: PublicRestoreEvidenceV1 | null = null;
  let requiredChecks: readonly LegacyCompositeCheck[] = RESTORE_REQUIRED_CHECKS.map((checkId) => ({
    checkId,
    passed: false,
  }));
  let session: BrowserSession | null = null;
  let browserClose: BrowserCloseOutcome = { closed: true, detail: null };
  let environmentInvalid = false;
  const routeLedger: RouteLedger = {
    createCount: 0,
    getCount: 0,
    undeclaredCount: 0,
    duplicateDenied: false,
    createMethodMatch: false,
    createContentTypeMatch: false,
    createAfterEpoch: false,
    getMethodMatch: false,
    getPathMatch: false,
    getPath: '',
    capturedBody: null,
    capturedBodyText: '',
    response: null,
    malformedResponseDelivered: false,
  };

  /**
   * The exact raw primitives the accepted frontend serialize/restore handoff
   * carries. They are captured while the drive still owns them and are only read
   * by `bindRestoreObservation`; no legacy composite check, boolean result,
   * aggregate harness flag, or behavior outcome is consulted.
   */
  let transitionFacts: RestoreTransitionFactView | null = null;
  let meaningFacts: RestoreMeaningFactView | null = null;
  let rawSemanticsFacts: RestoreRawSemanticFactView | null = null;
  let sourceObservation: unknown = null;
  let restoredObservation: unknown = null;
  let capturedSourceDocumentId = '';
  let capturedRestoredDocumentId = '';
  let capturedRestoredObservationId: string | null = null;
  let finalObservation: FinalExecutionObservation | null = null;
  /**
   * True once this drive has entered family execution (the owned page opened).
   * A launch failure keeps it `false`, so the handoff stays `null`; every
   * post-launch terminal — including malformed or unavailable authority — binds
   * a non-null observation.
   */
  let familyExecutionEntered = false;

  /**
   * Assembles the immutable, envelope-bound frontend serialize/restore final
   * observation from the raw withheld primitives currently in scope and retains
   * the exact planning envelope by reference. It reads no legacy composite
   * `checks`, `passed`, `harnessInvalid`, `requiredSourcesAgree`, or behavior
   * outcome. It is called at every post-launch terminal, so a drive that
   * captured facts but failed a check still hands over an explicit
   * malformed/unavailable primitive view.
   */
  const bindRestoreObservation = (): void => {
    const actionCycleId = `final:${input.allocation.runId}:${input.caseId}:frontend-restore`;
    const authority = evaluation === null ? 'malformed' : evaluation.primitiveFacts.authority;
    const payload: FinalExecutionPayload = {
      evaluatorKind: 'frontend-restore',
      projection: buildRestoreProjectionHeader({
        profileDeadlineMs: profileDeadline,
        oracleProfileId,
        scenarioId: restoreScenarioId(input.fixture),
        sourceDocumentId: capturedSourceDocumentId,
        restoredDocumentId: capturedRestoredDocumentId,
        evaluation,
        actionCycleRef: actionCycleId,
      }),
      schemaVersion: RESTORE_OBSERVATION_SCHEMA_VERSION,
      transition: transitionFacts,
      meaning: meaningFacts,
      rawSemantics: rawSemanticsFacts,
      source: sourceObservation,
      restored: restoredObservation,
      setup: setupCheckpoints.map((checkpoint) => ({
        role: checkpoint.role,
        stepCount: checkpoint.stepCount,
        historyPastDepth: checkpoint.historyPastDepth,
        historyFutureDepth: checkpoint.historyFutureDepth,
        historyBaselineClean: checkpoint.historyBaselineClean,
        meaningFingerprint: checkpoint.meaningFingerprint,
      })),
      readiness: {
        policy: restoreReadinessPolicy(input.envelope),
        observation: {
          outcome: restoreReadinessOutcome(lastWakeSource),
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
      evidence: restoreEvidenceFacts(
        input.envelope.correctnessProfile.requiredAuthoritativeEvidence,
        authority,
      ),
    };
    finalObservation = Object.freeze({
      envelope: input.envelope,
      actionCycle: bindFinalActionCycleIdentity({ envelope: input.envelope, actionCycleId }),
      payload: Object.freeze(payload),
      observationId: capturedRestoredObservationId,
    });
  };

  const restoreReport = (
    outcome: Extract<Outcome, 'PASS' | 'BUG' | 'HARNESS_BLOCKED'>,
  ): RestoreDriveReport => ({
    schemaVersion: RESTORE_OBSERVATION_SCHEMA_VERSION,
    outcome,
    requiredChecks,
    harnessInvalid,
    diagnostics,
    evaluation,
    projection,
    readiness: {
      profileId: RESTORE_TRANSITION_PROFILE_ID,
      timingCategory: FRONTEND_RESTORE_V1_TIMING_CATEGORY,
      deadlineMs: profileDeadline,
      wakeSource: lastWakeSource,
      fallbackPollCount: 0,
      watchdogWaits,
      stableFrames,
      observedStableFrames,
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
      readinessProfileId: RESTORE_TRANSITION_PROFILE_ID,
      readinessDeadlineMs: profileDeadline,
      readinessStableFrames: stableFrames,
      readinessTimingCategory: FRONTEND_RESTORE_V1_TIMING_CATEGORY,
      oracleProfileId,
    },
    timings,
    detail,
    restore: null,
  });

  const blocked = (): ExecuteRestorePlanResult => {
    // A launch failure never entered family execution, so the handoff stays
    // `null`; every post-launch terminal binds an explicit observation.
    if (familyExecutionEntered) bindRestoreObservation();
    return {
      behavior: behaviorFor('HARNESS_BLOCKED'),
      restore: restoreReport('HARNESS_BLOCKED'),
      browserClose,
      environmentInvalid,
      finalObservation,
    };
  };

  let sessionPage: Page | null = null;
  let settledDeadlineAt = 0;
  const remaining = (): number => Math.max(0, Math.floor(settledDeadlineAt - now()));

  try {
    session = await (input.openPage ?? openFreshPage)({
      baseUrl: input.allocation.baseUrl,
      route: SETUP_ROUTE,
      environment: input.environment,
      navigationTimeoutMs: 60_000,
    });
    familyExecutionEntered = true;
    const { page } = session;
    sessionPage = page;
    const settleRuntime: HistorySettleRuntime = {
      waitForChange: (cursor, timeoutMs) =>
        page.evaluate(
          bridgeWaitForChangeScript(cursor, timeoutMs),
        ) as Promise<WaitForChangeOutcome>,
      waitForIdle: (frames, timeoutMs) => page.evaluate(bridgeWaitForIdleScript(frames, timeoutMs)),
      // The settlement reads the exact history state view through the checked
      // projection, never through an unchecked cast of an `unknown[]` snapshot.
      readState: () => page.evaluate(bridgeStateScript()).then(projectHistoryBridgeStateView),
    };

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
    if (sealProblem !== null || !constructed.ok) {
      harnessInvalid = true;
      diagnostics.push(
        createDiagnostic(
          'SETUP_HYDRATE_REJECTED',
          sealProblem ?? 'The setup constructor did not seal.',
        ),
      );
      detail = `Constructor refused: ${sealProblem ?? 'not sealed'}`;
      return blocked();
    }

    // ── Declared setup recipes: the fixture's role names are the closed
    // discriminants of the visible source-construction path.
    const recipes: RestoreSetupRecipe[] = [];
    for (const role of input.fixture.semanticTargetRoles) {
      const recipe = resolveRestoreSetupRecipe(role.role);
      if (recipe === null) {
        harnessInvalid = true;
        diagnostics.push(
          createDiagnostic(
            'SETUP_HISTORY_SHAPE_UNEXPECTED',
            `Fixture role "${role.role}" is not a declared restore setup recipe.`,
          ),
        );
        detail = `Unknown restore setup role "${role.role}".`;
        return blocked();
      }
      recipes.push(recipe);
    }
    if (recipes.length === 0) {
      harnessInvalid = true;
      diagnostics.push(
        createDiagnostic(
          'SETUP_HISTORY_SHAPE_UNEXPECTED',
          'The restore fixture declares no setup recipe.',
        ),
      );
      detail = 'No restore setup recipe declared.';
      return blocked();
    }

    // ── Optional initial tutorial, dismissed with no effect.
    const tutorialBefore = await observeInitialTutorial(page);
    const dismiss = await dismissInitialTutorial(page);
    if (tutorialBefore.present && !dismiss.dismissed) {
      harnessInvalid = true;
      diagnostics.push(createDiagnostic('SETUP_TUTORIAL_CONTROL_UNAVAILABLE', dismiss.detail));
      detail = 'Initial tutorial blocked setup.';
      return blocked();
    }

    const recordCheckpoint = (role: string, stepCount: number, state: BridgeStateView): void => {
      const normalized = meaningOf(state.snapshot, provider);
      setupCheckpoints.push({
        role,
        stepCount,
        historyPastDepth: state.snapshot.history.pastDepth,
        historyFutureDepth: state.snapshot.history.futureDepth,
        historyBaselineClean: state.snapshot.history.baselineClean,
        meaningFingerprint: provider.fingerprintNormalizedMeaning(normalized),
        canonical: provider.canonicalizeNormalizedMeaning(normalized),
      });
    };

    const runGuardedSelectionClear = async (): Promise<DiagnosticRecord | null> => {
      const preEscape = (await page.evaluate(bridgeStateScript())) as BridgeStateView | null;
      if (preEscape === null || !isWellFormedCursor(preEscape.cursor)) {
        return createDiagnostic(
          'SETUP_SELECTION_CLEAR_PRECONDITION_UNEXPECTED',
          'The pre-clear bridge state was unreadable.',
        );
      }
      const selectedBefore = [...preEscape.snapshot.selectedLayerIds];
      const moreBefore = attributeMoreControls(await observeMoreCandidates(page));
      const focus = await observeFocusedElement(page);
      const overlay = await observeCompetingOverlay(page);
      const residualOnboarding = await observeOnboardingPopover(page, 'Image placeholder');
      const expected = setupCheckpoints[setupCheckpoints.length - 1] ?? null;
      const ownershipFacts: EscapeOwnershipFacts = {
        createdPlaceholderResolvesOnce: selectedBefore.length === 1,
        createdPlaceholderSoleSelection: selectedBefore.length === 1,
        notEnteredGroupChildSelection: true,
        noActivePlacementOrEditingMode: !focus.isEditableTarget,
        focusNotEditable: !focus.isEditableTarget,
        noCompetingOverlayOwner: !overlay.anyOpen,
        noResidualOnboarding: !residualOnboarding.present,
        routeOwnedAndStable: page.url().includes('/artwork/editor'),
        // The guard is reused from ADR 0020: it proves the state is exactly the
        // committed checkpoint the clear starts from (field names are legacy).
        meaningIsM2:
          expected !== null &&
          provider.canonicalizeNormalizedMeaning(meaningOf(preEscape.snapshot, provider)) ===
            expected.canonical,
        historyIsH2:
          expected !== null &&
          preEscape.snapshot.history.pastDepth === expected.historyPastDepth &&
          preEscape.snapshot.history.futureDepth === expected.historyFutureDepth,
        moreAttribution: moreBefore.kind,
      };
      const ownership = evaluateEscapeOwnership(ownershipFacts);
      if (!ownership.ok) {
        return createDiagnostic(
          'SETUP_ESCAPE_OWNER_UNSAFE',
          `Escape ownership was unsafe: ${ownership.failed.join(', ')}.`,
        );
      }
      const escapeDispatch = await dispatchEscapeOnce(page);
      if (escapeDispatch.escapeDispatchCount !== 1) {
        return createDiagnostic(
          'SETUP_ESCAPE_OWNER_UNSAFE',
          'Exactly one Escape must be dispatched.',
        );
      }
      const postEscape = (await page.evaluate(bridgeStateScript())) as BridgeStateView | null;
      if (postEscape === null) {
        return createDiagnostic('SETUP_SELECTION_CLEAR_FAILED', 'Post-clear state was unreadable.');
      }
      const moreAfter = attributeMoreControls(await observeMoreCandidates(page));
      const railMore = await readUniqueRailMore(page);
      if (
        postEscape.snapshot.selectedLayerIds.length !== 0 ||
        moreAfter.actionableCount !== 1 ||
        moreAfter.kind !== 'single-rail' ||
        railMore === null
      ) {
        return createDiagnostic(
          'SETUP_SELECTION_CLEAR_FAILED',
          'One Escape did not clear selection and leave the unique rail More.',
        );
      }
      if (
        provider.canonicalizeNormalizedMeaning(meaningOf(postEscape.snapshot, provider)) !==
          expected?.canonical ||
        postEscape.snapshot.history.pastDepth !== expected?.historyPastDepth ||
        postEscape.snapshot.history.futureDepth !== expected?.historyFutureDepth
      ) {
        return createDiagnostic(
          'SETUP_SELECTION_CLEAR_MEANING_CHANGED',
          'The guarded Escape changed history or product meaning.',
        );
      }
      return null;
    };

    for (const recipe of recipes) {
      const pre = (await page.evaluate(bridgeStateScript())) as BridgeStateView | null;
      if (pre === null || !isWellFormedCursor(pre.cursor)) {
        harnessInvalid = true;
        diagnostics.push(
          createDiagnostic(
            'UNUSABLE_EVIDENCE',
            `The pre-setup state for role "${recipe.role}" was unreadable.`,
          ),
        );
        detail = `Pre-setup state for "${recipe.role}" unreadable.`;
        return blocked();
      }
      for (const action of recipe.actions) {
        if (action.primitive === 'control.activate') {
          const outcome = await activateControl({
            page,
            accessibleName: action.accessibleName as string,
          });
          if (!outcome.ok) {
            harnessInvalid = true;
            diagnostics.push(
              createDiagnostic(
                'SETUP_HISTORY_SHAPE_UNEXPECTED',
                `The declared setup control "${action.accessibleName}" was not actionable.`,
              ),
            );
            detail = `Setup control "${action.accessibleName}" unavailable.`;
            return blocked();
          }
        } else if (action.primitive === 'row.click') {
          const row = await clickUniqueTextRow(page, action.accessibleName as string);
          if (!row.ok) {
            harnessInvalid = true;
            diagnostics.push(
              createDiagnostic('SETUP_IMAGE_ONBOARDING_ORDER_UNEXPECTED', row.detail),
            );
            detail = `Setup row "${action.accessibleName}" was not uniquely actionable.`;
            return blocked();
          }
        } else if (action.primitive === 'onboarding.got-it') {
          const anchor = action.text as string;
          await page.waitForFunction(
            (text) => {
              const nodes = Array.from(document.querySelectorAll('p, span, h1, h2, h3, h4'));
              return nodes.some(
                (node) =>
                  node instanceof HTMLElement &&
                  node.offsetParent !== null &&
                  (node.textContent || '').trim() === text,
              );
            },
            anchor,
            { timeout: 10_000 },
          );
          const onboarding = await observeOnboardingPopover(page, anchor);
          if (onboarding.present && onboarding.gotItActionable !== 1) {
            harnessInvalid = true;
            diagnostics.push(
              createDiagnostic(
                'SETUP_ONBOARDING_CONTROL_AMBIGUOUS',
                `${onboarding.gotItActionable} actionable "Got it" controls; exactly one is required.`,
              ),
            );
            detail = 'Setup onboarding control ambiguous.';
            return blocked();
          }
          if (onboarding.present) {
            const gotIt = await activateControl({ page, accessibleName: 'Got it' });
            if (!gotIt.ok) {
              harnessInvalid = true;
              diagnostics.push(
                createDiagnostic(
                  'SETUP_ONBOARDING_CONTROL_AMBIGUOUS',
                  'The phase-owned onboarding "Got it" was not actionable.',
                ),
              );
              detail = 'Setup onboarding Got it unavailable.';
              return blocked();
            }
          }
        } else if (action.primitive === 'selection.clear') {
          const problem = await runGuardedSelectionClear();
          if (problem !== null) {
            harnessInvalid = true;
            diagnostics.push(problem);
            detail = `Guarded selection clear failed: ${problem.detail}`;
            return blocked();
          }
        }
      }
      const settled = await settleHistory(settleRuntime, pre.cursor, profileDeadline, now);
      lastWakeSource = settled.wakeSource;
      watchdogWaits += settled.watchdogWaits;
      if (!settled.ok || settled.state === null) {
        harnessInvalid = true;
        diagnostics.push(createDiagnostic('SETUP_HISTORY_SHAPE_UNEXPECTED', settled.detail));
        detail = settled.detail;
        return blocked();
      }
      recordCheckpoint(recipe.role, recipe.actions.length, settled.state);
    }

    // ── Coherent source observation S0 and its normalized meaning.
    const sourceState = (await page.evaluate(bridgeStateScript())) as BridgeStateView | null;
    if (sourceState === null || !isWellFormedCursor(sourceState.cursor)) {
      harnessInvalid = true;
      diagnostics.push(
        createDiagnostic('UNUSABLE_EVIDENCE', 'The coherent source observation was unreadable.'),
      );
      detail = 'Source observation unreadable.';
      return blocked();
    }
    const sourceSnapshot = sourceState.snapshot;
    const sourceDocumentId = sourceSnapshot.document.documentId;
    const sourceNormalized = meaningOf(sourceSnapshot, provider);
    const sourceCanonical = provider.canonicalizeNormalizedMeaning(sourceNormalized);
    const sourceFingerprint = provider.fingerprintNormalizedMeaning(sourceNormalized);
    const sourceTypedCrossword = typedCrosswordOf(sourceSnapshot);
    const sourceIds = idsOf(sourceSnapshot);
    const sourceCounts = layerCountOf(sourceSnapshot);

    // Capture the accepted coherent source document observation (with its live
    // bridge generation) while the raw snapshot and cursor are still in scope.
    capturedSourceDocumentId = sourceDocumentId;
    sourceObservation = restoreDocumentObservation({
      documentId: sourceDocumentId,
      documentEpoch: sourceSnapshot.document.documentEpoch,
      route: sourceSnapshot.route ?? SETUP_ROUTE,
      observationId: `${sourceDocumentId}:${sourceState.cursor.revision}`,
      observationRevision: sourceState.cursor.revision,
      bridgeGeneration: sourceState.cursor.bridgeGeneration,
      normalizedFingerprint: sourceFingerprint,
      canonicalDigest: sha256Hex(sourceCanonical),
      layoutCount: sourceCounts.layouts,
      layerCount: sourceCounts.layers,
      historyPastDepth: sourceSnapshot.history.pastDepth,
      historyFutureDepth: sourceSnapshot.history.futureDepth,
      historyBaselineClean: sourceSnapshot.history.baselineClean,
      activeLayoutId: sourceSnapshot.activeLayoutId,
      selectedLayerIds: [...sourceSnapshot.selectedLayerIds],
    });

    // ── Case-owned route fulfillment: arm signals, then click Save.
    const createCaptured = makeDeferred<void>();
    const getCaptured = makeDeferred<void>();
    const navigatePath = `${RESTORE_EDITOR_ROUTE_PREFIX}${RESTORE_DETERMINISTIC_ARTWORK_ID}`;

    await page.route('**/api/**', async (route: Route) => {
      const request: Request = route.request();
      const url = new URL(request.url());
      const path = url.pathname;
      const method = request.method();
      if (path === RESTORE_CREATE_PATH) {
        routeLedger.createCount += 1;
        if (routeLedger.createCount > 1) {
          routeLedger.duplicateDenied = true;
          await route.abort();
          return;
        }
        routeLedger.createMethodMatch = method === RESTORE_CREATE_METHOD;
        const contentType = request.headers()['content-type'] ?? '';
        routeLedger.createContentTypeMatch = contentType.includes(RESTORE_CREATE_CONTENT_TYPE);
        routeLedger.createAfterEpoch = true;
        const bodyText = request.postData() ?? '';
        routeLedger.capturedBodyText = bodyText;
        try {
          routeLedger.capturedBody = JSON.parse(bodyText) as Record<string, unknown>;
        } catch {
          routeLedger.capturedBody = null;
        }
        const response = buildDeterministicResponse(routeLedger.capturedBody ?? {});
        if (input.failureMode?.kind === 'mutate-response') {
          input.failureMode.mutate(response);
        }
        routeLedger.response = response;
        if (input.failureMode?.kind === 'malformed-response') {
          routeLedger.malformedResponseDelivered = true;
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: '{"data":',
          });
          createCaptured.resolve();
          return;
        }
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(response),
        });
        createCaptured.resolve();
        return;
      }
      if (method === 'GET' && path === `/api/artwork/${RESTORE_DETERMINISTIC_ARTWORK_ID}`) {
        routeLedger.getCount += 1;
        routeLedger.getPath = path;
        if (routeLedger.getCount > 1) {
          routeLedger.duplicateDenied = true;
          await route.abort();
          return;
        }
        routeLedger.getMethodMatch = true;
        routeLedger.getPathMatch = true;
        const body = routeLedger.response ?? buildDeterministicResponse({});
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(body),
        });
        getCaptured.resolve();
        return;
      }
      routeLedger.undeclaredCount += 1;
      await route.abort();
    });

    // Arm the single monotonic restore deadline immediately before the native
    // Save click.
    const armedAt = now();
    settledDeadlineAt = armedAt + profileDeadline;
    const saveLocator = page.getByRole('button', {
      name: RESTORE_SAVE_CONTROL.accessibleName,
      exact: true,
    });
    const saveMatches = await saveLocator.count();
    const saveEnabled = saveMatches === 1 ? await saveLocator.isEnabled() : false;
    if (input.failureMode?.kind === 'disable-save' || saveMatches !== 1 || !saveEnabled) {
      harnessInvalid = true;
      diagnostics.push(
        createDiagnostic(
          saveMatches === 0 ? 'RESTORE_ROUTE_CONTRACT_INVALID' : 'RESTORE_REQUEST_MISSING',
          saveMatches === 1
            ? 'The native seller Save control was disabled before dispatch.'
            : `The native seller Save control matched ${saveMatches} element(s); exactly one is required.`,
        ),
      );
      detail = 'Seller Save control was not uniquely actionable before dispatch.';
      return blocked();
    }
    await saveLocator.click();
    timings['restore.save'] = now() - armedAt;

    // ── POST capture → product redirect.
    try {
      await withTimeout(
        createCaptured.promise,
        remaining(),
        'No POST /api/artwork/create was captured before the restore deadline.',
      );
    } catch (error) {
      harnessInvalid = true;
      diagnostics.push(createDiagnostic('RESTORE_REQUEST_MISSING', (error as Error).message));
      detail = (error as Error).message;
      return blocked();
    }
    timings['restore.post'] = now() - armedAt;

    // A malformed response is a harness-authority failure: the product cannot be
    // given an interpretable create response, so the redirect can never occur and
    // no product claim is made.
    if (routeLedger.malformedResponseDelivered) {
      harnessInvalid = true;
      diagnostics.push(
        createDiagnostic(
          'RESTORE_RESPONSE_INVALID',
          'The deterministic route contract delivered a malformed response body; the product could not consume an interpretable response.',
        ),
      );
      detail = 'Malformed restore response blocked the product claim.';
      return blocked();
    }

    try {
      await page.waitForURL((url) => url.pathname === RESTORE_REDIRECT_PATH, {
        timeout: Math.max(1, remaining()),
      });
    } catch {
      harnessInvalid = true;
      diagnostics.push(
        createDiagnostic(
          'RESTORE_ROUTE_CONTRACT_INVALID',
          `The product did not redirect to ${RESTORE_REDIRECT_PATH} after the create POST.`,
        ),
      );
      detail = 'Product redirect after Save was not observed.';
      return blocked();
    }
    timings['restore.redirect'] = now() - armedAt;

    // ── Explicit navigation to the restored editor route and exact GET.
    await page.goto(`${input.allocation.baseUrl}${navigatePath}`, {
      waitUntil: 'domcontentloaded',
      timeout: Math.max(1, remaining()),
    });
    try {
      await withTimeout(
        getCaptured.promise,
        remaining(),
        'No GET /api/artwork/<id> was captured before the restore deadline.',
      );
    } catch (error) {
      harnessInvalid = true;
      diagnostics.push(createDiagnostic('RESTORE_REQUEST_MISSING', (error as Error).message));
      detail = (error as Error).message;
      return blocked();
    }
    timings['restore.get'] = now() - armedAt;

    // ── New bridge mount on the restored document.
    try {
      await page.waitForFunction(
        (name) => Boolean((window as unknown as Record<string, unknown>)[name]),
        OBSERVATION_GLOBAL_NAME,
        { timeout: Math.max(1, remaining()) },
      );
    } catch {
      harnessInvalid = true;
      diagnostics.push(
        createDiagnostic(
          'RESTORE_DOCUMENT_TRANSITION_MISSING',
          'The restored editor did not mount the observation bridge before the restore deadline.',
        ),
      );
      detail = 'Restored bridge did not mount.';
      return blocked();
    }
    try {
      await page.waitForFunction(
        () => {
          const bridge = (window as unknown as Record<string, unknown>)[
            '__MAKEIT_ARTWORK_VERIFICATION__'
          ] as { snapshot?: () => { layoutItems?: unknown[] } } | undefined;
          const snapshot = bridge?.snapshot?.();
          const items = Array.isArray(snapshot?.layoutItems) ? snapshot.layoutItems : [];
          return items.some((item) => {
            const record = item as { isCanvas?: unknown; layers?: unknown };
            return (
              record.isCanvas !== true && Array.isArray(record.layers) && record.layers.length > 0
            );
          });
        },
        undefined,
        { timeout: Math.max(1, remaining()) },
      );
    } catch {
      harnessInvalid = true;
      diagnostics.push(
        createDiagnostic(
          'RESTORE_DOCUMENT_TRANSITION_MISSING',
          'The restored document did not expose hydrated restored content before the restore deadline.',
        ),
      );
      detail = 'Restored hydration did not complete.';
      return blocked();
    }

    const restoredPreIdle = (await page.evaluate(bridgeStateScript())) as BridgeStateView | null;
    if (restoredPreIdle === null || !isWellFormedCursor(restoredPreIdle.cursor)) {
      harnessInvalid = true;
      diagnostics.push(
        createDiagnostic('UNUSABLE_EVIDENCE', 'The restored bridge state was unreadable.'),
      );
      detail = 'Restored bridge unreadable.';
      return blocked();
    }
    if (restoredPreIdle.cursor.documentId === sourceDocumentId) {
      harnessInvalid = true;
      diagnostics.push(
        createDiagnostic(
          'RESTORE_DOCUMENT_TRANSITION_MISSING',
          'The restored editor did not mount on a distinct browser document identity.',
        ),
      );
      detail = 'Restored document identity was not distinct from the source.';
      return blocked();
    }
    await page.evaluate(bridgeWaitForIdleScript(stableFrames, Math.max(1, remaining())));
    observedStableFrames = stableFrames;
    timings['restore.mount'] = now() - armedAt;

    const restoredState = (await page.evaluate(bridgeStateScript())) as BridgeStateView | null;
    if (restoredState === null || !isWellFormedCursor(restoredState.cursor)) {
      harnessInvalid = true;
      diagnostics.push(
        createDiagnostic('UNUSABLE_EVIDENCE', 'The coherent restored observation was unreadable.'),
      );
      detail = 'Restored observation unreadable.';
      return blocked();
    }
    const restoredSnapshot = restoredState.snapshot;
    const restoredNormalized = meaningOf(restoredSnapshot, provider);
    const restoredCanonical = provider.canonicalizeNormalizedMeaning(restoredNormalized);
    const restoredFingerprint = provider.fingerprintNormalizedMeaning(restoredNormalized);
    const restoredTypedCrossword = typedCrosswordOf(restoredSnapshot);
    const restoredIds = idsOf(restoredSnapshot);
    const restoredCounts = layerCountOf(restoredSnapshot);

    // Capture the accepted coherent restored document observation (with its live
    // bridge generation) while the raw snapshot and cursor are still in scope.
    capturedRestoredDocumentId = restoredSnapshot.document.documentId;
    capturedRestoredObservationId = `${restoredSnapshot.document.documentId}:${restoredState.cursor.revision}`;
    restoredObservation = restoreDocumentObservation({
      documentId: restoredSnapshot.document.documentId,
      documentEpoch: restoredSnapshot.document.documentEpoch,
      route: restoredSnapshot.route ?? navigatePath,
      observationId: capturedRestoredObservationId,
      observationRevision: restoredState.cursor.revision,
      bridgeGeneration: restoredState.cursor.bridgeGeneration,
      normalizedFingerprint: restoredFingerprint,
      canonicalDigest: sha256Hex(restoredCanonical),
      layoutCount: restoredCounts.layouts,
      layerCount: restoredCounts.layers,
      historyPastDepth: restoredSnapshot.history.pastDepth,
      historyFutureDepth: restoredSnapshot.history.futureDepth,
      historyBaselineClean: restoredSnapshot.history.baselineClean,
      activeLayoutId: restoredSnapshot.activeLayoutId,
      selectedLayerIds: [...restoredSnapshot.selectedLayerIds],
    });

    const normalizedStructurallyEqual = sourceCanonical === restoredCanonical;
    const normalizedFingerprintEqual = sourceFingerprint === restoredFingerprint;
    const inventoryPreserved =
      sourceCounts.layouts === restoredCounts.layouts &&
      sourceCounts.layers === restoredCounts.layers;

    const payloadCrossword =
      provider.extractRawCrosswordSemanticPayload(routeLedger.capturedBody);
    const crosswordPresent = payloadCrossword !== null;
    const layoutDigest =
      payloadCrossword === null ? null : crossWordLayoutDigest(payloadCrossword.layout, provider);
    const restoredLayoutDigest =
      restoredTypedCrossword === null
        ? null
        : crossWordLayoutDigest(restoredTypedCrossword.layout, provider);

    const volatileIdsDiffer =
      restoredIds.layers.length > 0 &&
      restoredIds.layers.every((id) => !sourceIds.layers.includes(id)) &&
      restoredIds.layouts.every((id) => !sourceIds.layouts.includes(id));

    const rawConfigPresent =
      routeLedger.capturedBody !== null &&
      Array.isArray(routeLedger.capturedBody.layouts) &&
      (routeLedger.capturedBody.layouts as Record<string, unknown>[]).some(
        (layout) =>
          Array.isArray(layout.layers) &&
          (layout.layers as Record<string, unknown>[]).some(
            (layer) => layer.config !== null && typeof layer.config === 'object',
          ),
      );

    const responseData = (routeLedger.response?.data ?? {}) as Record<string, unknown>;
    const rawServerMetadataPresent =
      routeLedger.response !== null &&
      typeof routeLedger.response.message === 'string' &&
      typeof routeLedger.response.timestamp === 'string' &&
      typeof responseData.createdAt === 'string' &&
      typeof responseData.updatedAt === 'string';

    const normalizedHasNoIdKey =
      !hasKeyInCanonical(sourceCanonical, 'id') && !hasKeyInCanonical(restoredCanonical, 'id');
    const normalizedHasNoConfigKey =
      !hasKeyInCanonical(sourceCanonical, 'config') &&
      !hasKeyInCanonical(restoredCanonical, 'config');
    const normalizedHasNoServerMetadata =
      !hasKeyInCanonical(restoredCanonical, 'createdAt') &&
      !hasKeyInCanonical(restoredCanonical, 'updatedAt') &&
      !hasKeyInCanonical(restoredCanonical, 'shopId') &&
      !hasKeyInCanonical(restoredCanonical, 'serverId') &&
      !hasKeyInCanonical(restoredCanonical, 'ownerId') &&
      !hasKeyInCanonical(restoredCanonical, 'assetId');

    const facts: RestoreOracleFacts = {
      schemaVersion: 1,
      requiredChecks: RESTORE_REQUIRED_CHECKS,
      transition: {
        saveDispatchedOnce: true,
        createRequestCount: routeLedger.createCount,
        createMethodMatches: routeLedger.createMethodMatch,
        createPathMatches: routeLedger.createCount === 1,
        createContentTypeMatches: routeLedger.createContentTypeMatch,
        createAfterEpoch: routeLedger.createAfterEpoch,
        getRequestCount: routeLedger.getCount,
        getMethodMatches: routeLedger.getMethodMatch,
        getPathMatches: routeLedger.getPathMatch,
        redirectObserved: true,
        navigateRouteMatches: page.url().includes(navigatePath),
        documentIdentityDistinct: restoredSnapshot.document.documentId !== sourceDocumentId,
        restoredHistoryClean:
          restoredSnapshot.history.pastDepth === 0 &&
          restoredSnapshot.history.futureDepth === 0 &&
          restoredSnapshot.history.baselineClean === true,
        harnessHydrateCalls: 0,
        harnessStoreMutationCalls: 0,
      },
      meaning: {
        normalizedStructurallyEqual,
        normalizedFingerprintEqual,
        sourceFingerprint,
        restoredFingerprint,
        inventoryPreserved,
        persistenceLossDetected: !normalizedStructurallyEqual,
      },
      rawSemantics: {
        crosswordPresent,
        generationSeed: payloadCrossword?.generationSeed ?? null,
        words: payloadCrossword?.words ?? [],
        layoutDigest,
        restoredSeedMatches:
          payloadCrossword === null ||
          (restoredTypedCrossword !== null &&
            restoredTypedCrossword.generationSeed === payloadCrossword.generationSeed),
        restoredWordsMatch:
          payloadCrossword === null ||
          (restoredTypedCrossword !== null &&
            sameWords(restoredTypedCrossword.words, payloadCrossword.words)),
        restoredLayoutDigestMatches:
          payloadCrossword === null || layoutDigest === restoredLayoutDigest,
        rawConfigPresent,
        rawServerMetadataPresent,
        normalizedHasNoIdKey,
        normalizedHasNoConfigKey,
        normalizedHasNoServerMetadata,
        volatileIdsDiffer,
      },
    };

    // Withhold the exact raw transition/meaning/raw-semantics views for the
    // final handoff before any legacy composite authority is consulted.
    transitionFacts = facts.transition;
    meaningFacts = facts.meaning;
    rawSemanticsFacts = facts.rawSemantics;

    if (routeLedger.duplicateDenied) {
      harnessInvalid = true;
      diagnostics.push(
        createDiagnostic(
          'RESTORE_REQUEST_DUPLICATE',
          'A duplicate or undeclared route call was denied by the case-owned route contract.',
        ),
      );
    }
    if (!routeLedger.createMethodMatch || !routeLedger.createContentTypeMatch) {
      harnessInvalid = true;
      diagnostics.push(
        createDiagnostic(
          'RESTORE_ROUTE_CONTRACT_INVALID',
          'The captured create request did not match the exact POST/JSON contract.',
        ),
      );
    }
    if (!routeLedger.getPathMatch) {
      harnessInvalid = true;
      diagnostics.push(
        createDiagnostic(
          'RESTORE_ROUTE_CONTRACT_INVALID',
          'The captured GET did not address the exact restored artwork id.',
        ),
      );
    }

    evaluation = evaluateRestoreOracle(facts, RESTORE_REQUIRED_CHECKS);
    diagnostics.push(...evaluation.diagnostics);
    requiredChecks = evaluation.checks;
    const outcome: Extract<Outcome, 'PASS' | 'BUG' | 'HARNESS_BLOCKED'> = harnessInvalid
      ? 'HARNESS_BLOCKED'
      : bugObserved || !evaluation.passed
        ? 'BUG'
        : 'PASS';
    if (outcome === 'HARNESS_BLOCKED') harnessInvalid = true;
    detail =
      outcome === 'PASS'
        ? 'The real seller Save round trip preserved normalized product meaning and the raw Crossword/config/server-metadata checks, with no harness hydration or store mutation.'
        : 'The frontend serialize/restore round trip did not preserve the required normalized/raw product semantics.';

    if (outcome === 'PASS' && routeLedger.capturedBody !== null && routeLedger.response !== null) {
      const evidenceBase = `observation:${sourceState.cursor.revision}->${restoredState.cursor.revision}`;
      projection = {
        schemaVersion: 1,
        normalizationProfileId: 'artwork-product-meaning-v1',
        readinessProfileId: RESTORE_TRANSITION_PROFILE_ID,
        // Preserve the literal closed restore Oracle id in the public record
        // instead of widening the resolved registration value to `string`.
        oracleProfileId: RESTORE_ORACLE_PROFILE_ID,
        timingCategory: FRONTEND_RESTORE_V1_TIMING_CATEGORY,
        deadlineMs: 15000,
        frontendOnly: true,
        backendPersistenceClaimed: false,
        scenarioId:
          input.fixture.scenarioId === 'serialize-raw-semantic'
            ? 'serialize-raw-semantic'
            : 'serialize-roundtrip',
        source: {
          documentId: sourceDocumentId,
          documentEpoch: sourceSnapshot.document.documentEpoch,
          route: sourceSnapshot.route ?? SETUP_ROUTE,
          observationId: `${sourceDocumentId}:${sourceState.cursor.revision}`,
          observationRevision: sourceState.cursor.revision,
          normalizedFingerprint: sourceFingerprint,
          canonicalDigest: sha256Hex(sourceCanonical),
          layoutCount: sourceCounts.layouts,
          layerCount: sourceCounts.layers,
          historyPastDepth: sourceSnapshot.history.pastDepth,
          historyFutureDepth: sourceSnapshot.history.futureDepth,
          historyBaselineClean: sourceSnapshot.history.baselineClean,
        },
        restored: {
          documentId: restoredSnapshot.document.documentId,
          documentEpoch: restoredSnapshot.document.documentEpoch,
          route: navigatePath,
          observationId: `${restoredSnapshot.document.documentId}:${restoredState.cursor.revision}`,
          observationRevision: restoredState.cursor.revision,
          normalizedFingerprint: restoredFingerprint,
          canonicalDigest: sha256Hex(restoredCanonical),
          layoutCount: restoredCounts.layouts,
          layerCount: restoredCounts.layers,
          historyPastDepth: restoredSnapshot.history.pastDepth,
          historyFutureDepth: restoredSnapshot.history.futureDepth,
          historyBaselineClean: restoredSnapshot.history.baselineClean,
        },
        setup: setupCheckpoints.map((checkpoint) => ({
          role: checkpoint.role,
          stepCount: checkpoint.stepCount,
          historyPastDepth: checkpoint.historyPastDepth,
          historyFutureDepth: checkpoint.historyFutureDepth,
          historyBaselineClean: checkpoint.historyBaselineClean,
          meaningFingerprint: checkpoint.meaningFingerprint,
        })),
        route: {
          saveControlAccessibleName: RESTORE_SAVE_CONTROL.accessibleName,
          saveDispatchCount: 1,
          createMethod: 'POST',
          createPath: '/api/artwork/create',
          createContentType: RESTORE_CREATE_CONTENT_TYPE,
          createRequestCount: 1,
          redirectPath: '/artwork',
          redirectObserved: true,
          getMethod: 'GET',
          getPath: routeLedger.getPath,
          getRequestCount: 1,
          navigatePath,
        },
        transport: {
          requestLogicalId: `restore-request:post:${RESTORE_CREATE_PATH}:1`,
          requestDtoLogicalId: `restore-dto:${sha256Hex(routeLedger.capturedBodyText).slice(0, 16)}`,
          responseLogicalId: `restore-response:${RESTORE_DETERMINISTIC_ARTWORK_ID}`,
          responseArtworkId: RESTORE_DETERMINISTIC_ARTWORK_ID,
          responseLayoutCount: Array.isArray(responseData.layouts)
            ? (responseData.layouts as unknown[]).length
            : 0,
          responseMessage: RESTORE_RESPONSE_MESSAGE,
          responseTimestamp: RESTORE_RESPONSE_TIMESTAMP,
          rawArtifactId: `restore-raw:${sha256Hex(routeLedger.capturedBodyText).slice(0, 16)}`,
          rawArtifactRedactionPassed: true,
        },
        exclusions: {
          volatileIdsDiffer,
          rawConfigPresent,
          rawServerMetadataPresent,
          normalizedHasNoIdKey,
          normalizedHasNoConfigKey,
          normalizedHasNoServerMetadata,
        },
        rawSemantics: {
          crosswordPresent,
          generationSeed: payloadCrossword?.generationSeed ?? null,
          words: payloadCrossword?.words ?? [],
          layoutDigest,
          restoredSeedMatches: facts.rawSemantics.restoredSeedMatches,
          restoredWordsMatches: facts.rawSemantics.restoredWordsMatch,
          restoredLayoutDigestMatches: facts.rawSemantics.restoredLayoutDigestMatches,
          layoutDigestAlgorithm: 'sha256',
          layoutDigestDomain: RESTORE_CROSSWORD_LAYOUT_DOMAIN,
        },
        documentIdentityDistinct: true,
        normalizedStructurallyEqual: true,
        normalizedFingerprintEqual: true,
        inventoryPreserved: true,
        persistenceLossDetected: false,
        harnessHydrateCalls: 0,
        harnessStoreMutationCalls: 0,
        checks: evaluation.checks.map((check) => ({
          checkId: check.checkId,
          passed: check.passed,
          evidenceIds: [evidenceBase],
        })),
      };
    }
    bindRestoreObservation();
    return {
      behavior: { ...behaviorFor(outcome), restore: restoreReport(outcome) },
      restore: restoreReport(outcome),
      browserClose,
      environmentInvalid,
      finalObservation,
    };
  } catch (error) {
    environmentInvalid = true;
    detail = `Restore drive failed during owned execution: ${(error as Error).message}`;
    return blocked();
  } finally {
    try {
      if (sessionPage !== null) await sessionPage.unrouteAll({ behavior: 'ignoreErrors' });
    } catch {
      // Route teardown is best-effort; the browser close below owns the context.
    }
    if (session) {
      browserClose = await closeBrowserSession(session);
      session = null;
    }
  }
}
