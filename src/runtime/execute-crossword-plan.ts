import type { Page } from '@playwright/test';

import {
  buildAdapterResolutionBaseline,
  fixtureHasPostActionRoles,
  rolesForPhase,
  type AdapterElementFact,
  type AdapterResolutionBaseline,
  type SubjectAdapter,
} from '../contracts/adapter';
import type { ExecutionPlan } from '../contracts/case-model';
import type { CaseIntent } from '../contracts/case-model';
import { createDiagnostic, type DiagnosticRecord } from '../contracts/diagnostics';
import type { Outcome } from '../contracts/discriminants';
/**
 * Private/deprecated legacy composite check mirror (ADR 0032 §E3-S1). It is
 * retained only so this active runtime executor producer compiles until the
 * E3-S2 architecture switch consumes the additive `primitiveFacts` the Crossword
 * Oracle exposes through `CrosswordOracleEvaluation`. It is deliberately
 * declared locally (never imported from `contracts/execution`) so the producer
 * no longer reaches the legacy boolean result authority, and it is never the
 * source of a final status.
 *
 * @deprecated E3-S2 removes the legacy composite authority entirely.
 */
interface LegacyCompositeCheck {
  readonly checkId: string;
  readonly passed: boolean;
}
import type { BindingFixture } from '../contracts/fixtures';
import {
  cursorKey,
  cursorsEqual,
  type ObservationCursor,
  type WaitForChangeOutcome,
  type WakeSource,
} from '../contracts/observation';
import type { EnvironmentCell, RunAllocation } from '../contracts/runtime';
import { OBSERVATION_GLOBAL_NAME, SETUP_GLOBAL_NAME, SETUP_ROUTE } from '../contracts/seam';
import type { SetupSealRecord } from '../contracts/seam';
import type { WorkflowStep } from '../contracts/workflows';
import {
  CROSSWORD_COMPARISON_PROFILE_ID,
  CROSSWORD_EXECUTION_ROLES,
  type CrosswordExecutionChildInput,
  type CrosswordExecutionRole,
  type CrosswordTargetGeometryV1,
} from '../contracts/crossword-observation';
import {
  crosswordSemanticDigest,
  crosswordSemanticPayloadFromLayerShape,
  crosswordWordsFingerprint,
} from '../contracts/crossword';
import {
  rasterRegionAgreesWithTarget,
  readAcceptedRasterAuthority,
  type GeneratedVectorRasterRecordView,
} from '../contracts/raster';
import { FINAL_NESTED_PROJECTION_SCHEMA_VERSION } from '../contracts/final-record-v4';
import { WALL_CLOCK_NAMESPACE, WALL_CLOCK_PROVIDER_ID } from '../contracts/wall-clock';
import type { MaterializedExecutionEnvelopeV1 } from '../planner/execution-materialization';
import { evaluateCrosswordOracle, type CrosswordOracleEvaluation } from '../oracles/crossword';
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
import {
  awaitCausalTransition,
  type CausalPredicateResult,
  type CorrelatedGateResult,
} from '../readiness/correlated-gate';
import { resolveReadinessProfile } from '../readiness/profile-registry';
import type { ReadinessProfile } from '../readiness/correlated-gate';
import { executeWorkflowSteps, type StepActionLog } from '../workflows/execute';
import type {
  CrosswordProjectionHeader,
  DiagnosticBridgeSnapshot,
  ExecutePlanBehavior,
  FinalExecutionObservation,
  FinalExecutionPayload,
} from './execute-plan';
import { bindFinalActionCycleIdentity } from './action-cycle';
import { CROSSWORD_GENERATION_READINESS_PROFILE } from '../adapters/generated-specialized';
import { readCrosswordSourceContract } from './crossword-source';

/**
 * Three-child generated-Crossword diagnostic drive (ADR 0017; ADR 0018 CR5–CR8).
 *
 * A1, A2, and B execute sequentially on one exclusively owned server, but each
 * owns a fresh browser process, non-persistent context, page/document, setup
 * authorization, clock installation, route/storage state, bridge chain, target
 * id, and cleanup result. No document, epoch, runtime target, clock, storage, or
 * route handler crosses a child boundary.
 *
 * The drive is selected by the closed role-timing discriminant of the resolved
 * fixture (a `post-action-new` role), never by a Subject-name, scenario, or
 * word-literal branch. Every root-cause decision here is a declared, closed
 * profile/role fact.
 */

/** Target-aware idle facts observed for one child (ADR 0017 R13). */
export interface CrosswordIdleFacts {
  targetCount: number;
  stableFrames: number;
  waitedMs: number;
  observationRevision: number;
}

export interface CrosswordChildExecutionReport {
  executionRole: CrosswordExecutionRole;
  outcome: Extract<Outcome, 'PASS' | 'BUG' | 'HARNESS_BLOCKED'>;
  evidence: CrosswordExecutionChildInput | null;
  observationId: string | null;
  tornRecaptureCount: number;
  contextClosed: boolean;
  /** Actual target-aware idle result; `null` when no idle was reached. */
  idle: CrosswordIdleFacts | null;
  detail: string;
  diagnostics: readonly DiagnosticRecord[];
}

export interface CrosswordDriveReport {
  schemaVersion: 1;
  outcome: Extract<Outcome, 'PASS' | 'BUG' | 'HARNESS_BLOCKED'>;
  requiredChecks: readonly LegacyCompositeCheck[];
  harnessInvalid: boolean;
  diagnostics: readonly DiagnosticRecord[];
  evaluation: CrosswordOracleEvaluation | null;
  children: readonly CrosswordChildExecutionReport[];
  readiness: {
    profileId: string;
    timingCategory: string;
    deadlineMs: number;
    wakeSource: WakeSource;
    fallbackPollCount: number;
    watchdogWaits: number;
    /** Configured stable-frame requirement of the bound profile. */
    stableFrames: number;
    /** Actual target-aware idle stable-frame count (0 when no idle was reached). */
    observedStableFrames: number;
    /** Aggregate target-aware idle result, present only when a child idled. */
    idle: CrosswordIdleFacts | null;
    timings: Readonly<Record<string, number | null>>;
  };
  detail: string;
}

export interface ExecuteCrosswordPlanInput {
  allocation: RunAllocation;
  caseId: string;
  intent: CaseIntent;
  plan: ExecutionPlan;
  adapter: SubjectAdapter;
  fixture: BindingFixture;
  workflowSteps: readonly WorkflowStep[];
  environment: EnvironmentCell;
  /**
   * The exact `MaterializedExecutionEnvelopeV1` compiled once during planning.
   * The Crossword executor places this exact object by reference in
   * `FinalExecutionObservation.envelope`; it never recompiles, looks up, or
   * reconstructs a profile.
   */
  envelope: MaterializedExecutionEnvelopeV1;
  openPage?: typeof openFreshPage;
  now?: () => number;
}

export interface ExecuteCrosswordPlanResult {
  behavior: ExecutePlanBehavior;
  crossword: CrosswordDriveReport;
  browserClose: BrowserCloseOutcome;
  environmentInvalid: boolean;
  /**
   * The exact envelope-bound final observation handoff for this executor run.
   * It is the canonical field the Diagnostic façade forwards; it is `null` only
   * before any family execution was entered (a pre-behavior source/clock/
   * readiness refusal), never for a drive that ran and produced malformed or
   * unavailable authority.
   */
  finalObservation: FinalExecutionObservation | null;
}

const CHILD_ROUTE = SETUP_ROUTE;
const IDLE_TIMEOUT_FROM_DEADLINE_MS = 1_000;

interface BridgeElementFactView {
  id: string;
  kind: string;
  parentId: string | null;
  mounted: boolean;
  hidden?: boolean;
  selected?: boolean;
  children?: readonly string[];
}

interface BridgeElementsView {
  observation: ObservationCursor;
  elements: readonly BridgeElementFactView[];
}

interface BridgeSnapshotView extends DiagnosticBridgeSnapshot {
  observation: ObservationCursor;
  layoutItems: readonly {
    id: string;
    isCanvas?: boolean;
    layers?: readonly {
      id: string;
      crossword?: Record<string, unknown> | null;
      config?: { crossword?: Record<string, unknown> } | null;
    }[];
  }[];
  activeLayoutId: string;
  selectedLayerIds: readonly string[];
  history: { pastDepth: number; futureDepth: number; baselineClean: boolean };
}

function bridgeCallScript(body: string): string {
  return `(() => {
  const bridge = window[${JSON.stringify(OBSERVATION_GLOBAL_NAME)}];
  if (!bridge) return { __bridgeMissing: true };
  ${body}
})()`;
}

function bridgeAsyncScript(body: string): string {
  return `(async () => {
  const bridge = window[${JSON.stringify(OBSERVATION_GLOBAL_NAME)}];
  if (!bridge) return { __bridgeMissing: true };
  ${body}
})()`;
}

function isBridgeMissing(value: unknown): value is { __bridgeMissing: true } {
  return typeof value === 'object' && value !== null && '__bridgeMissing' in value;
}

/** Structural view of the bridge `waitForIdle` result (ADR 0017 R13). */
interface BridgeIdleResultView {
  idle: boolean;
  waitedMs: number;
  stableFrames: number;
  observation: unknown;
  renderer?: unknown;
}

export type { DeadlineResult };

/** Structural view of the bridge `geometry(id)` result for the exact target. */
export interface BridgeGeometryView {
  observation: unknown;
  id: string;
  mounted: boolean;
  visible?: boolean;
  stageRect?: { x: number; y: number; width: number; height: number };
  viewportRect?: { x: number; y: number; width: number; height: number };
  renderer?: { targetFingerprint?: unknown; bridgeGeneration?: unknown };
}

type DeadlineResult<T> = { ok: true; value: T } | { ok: false; detail: string };

/**
 * Races one awaited readiness/capture step against the single non-extending
 * Node-monotonic deadline (ADR 0017 R13; ADR 0018 CR8). No readiness, fonts,
 * capture, hash, or recapture await is ever unbounded: a hung promise resolves
 * this wrapper as a deadline outcome and the drive fails closed. The losing
 * promise's rejection is swallowed so it can never surface as an unhandled
 * rejection.
 */
export async function withinDeadline<T>(
  promise: Promise<T>,
  deadlineAt: number,
  now: () => number,
  label: string,
): Promise<DeadlineResult<T>> {
  const remaining = Math.max(0, deadlineAt - now());
  const settled = promise.then((value) => ({ ok: true as const, value }));
  void settled.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<DeadlineResult<T>>((resolve) => {
    timer = setTimeout(
      () =>
        resolve({
          ok: false,
          detail: `${label} did not complete inside the 8-second Node-monotonic readiness deadline.`,
        }),
      remaining,
    );
  });
  try {
    const outcome = await Promise.race([settled, timeout]);
    if (outcome.ok) return outcome;
    return outcome;
  } catch (error) {
    return { ok: false, detail: `${label} failed: ${(error as Error).message}` };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function isWellFormedCursor(value: unknown): value is ObservationCursor {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.schemaVersion === 'number' &&
    typeof record.documentId === 'string' &&
    record.documentId.length > 0 &&
    Number.isSafeInteger(record.documentEpoch) &&
    (record.documentEpoch as number) >= 1 &&
    typeof record.bridgeVersion === 'number' &&
    Number.isSafeInteger(record.bridgeGeneration) &&
    (record.bridgeGeneration as number) >= 1 &&
    Number.isSafeInteger(record.revision) &&
    (record.revision as number) >= 0
  );
}

function sealFailure(outcome: SetupConstructorOutcome): string | null {
  if (outcome.ok) return null;
  if (outcome.outcome === 'absent') return `Setup boundary is not installed: ${outcome.detail}`;
  return `Setup refusal ${outcome.code}: ${outcome.detail}`;
}

function access<T>(record: Record<string, unknown>, key: string): T | undefined {
  return record[key] as T | undefined;
}

/** Reads the exact active-host Crossword ids from the live element facts. */
function activeHostCrosswordIds(
  elements: readonly BridgeElementFactView[],
  activeLayoutId: string,
): string[] {
  return elements
    .filter((element) => element.kind === 'crossword' && element.parentId === activeLayoutId)
    .map((element) => element.id);
}

function allCrosswordIds(elements: readonly BridgeElementFactView[]): string[] {
  return elements.filter((element) => element.kind === 'crossword').map((element) => element.id);
}

/** Normalizes the bridge element facts into the adapter's fact shape. */
function toAdapterFacts(elements: readonly BridgeElementFactView[]): AdapterElementFact[] {
  return elements.map((element) => ({
    id: element.id,
    kind: element.kind,
    parentId: element.parentId,
    mounted: element.mounted,
    ...(element.hidden === undefined ? {} : { hidden: element.hidden }),
    ...(element.selected === undefined ? {} : { selected: element.selected }),
    ...(element.children === undefined ? {} : { children: element.children }),
  }));
}

interface ChildRunInput {
  input: ExecuteCrosswordPlanInput;
  executionRole: CrosswordExecutionRole;
  baselineUtc: string;
  expectedSeed: number;
  notionalActiveLayoutId: string | null;
  sourceFingerprintExpected: string;
  now: () => number;
  profile: ReadinessProfile;
}

interface ChildRunOutcome {
  report: CrosswordChildExecutionReport;
  cursor: ObservationCursor | null;
  wakeSource: WakeSource;
  fallbackPollCount: number;
  watchdogWaits: number;
  gate: CorrelatedGateResult | null;
  actionLogs: readonly StepActionLog[];
  timings: Readonly<Record<string, number | null>>;
  browserClose: BrowserCloseOutcome;
  idle: CrosswordIdleFacts | null;
}

function failedChild(
  executionRole: CrosswordExecutionRole,
  detail: string,
  diagnostics: readonly DiagnosticRecord[],
  extras: Partial<ChildRunOutcome> = {},
): ChildRunOutcome {
  return {
    report: {
      executionRole,
      outcome: 'HARNESS_BLOCKED',
      evidence: null,
      observationId: null,
      tornRecaptureCount: 0,
      contextClosed: true,
      idle: null,
      detail,
      diagnostics,
    },
    cursor: null,
    wakeSource: 'none',
    fallbackPollCount: 0,
    watchdogWaits: 0,
    gate: null,
    actionLogs: [],
    timings: {},
    browserClose: { closed: true, detail: null },
    idle: null,
    ...extras,
  };
}

/**
 * Reconciles one page's mounted generated-vector raster record for the exact
 * created target (ADR 0017 R12). The record must be a ready, mounted,
 * exact-id generated-vector projection. No screenshot, AABB, or cross-context
 * equality is accepted.
 */
async function readGeneratedVectorRaster(
  page: Page,
  createdTargetId: string,
): Promise<{
  record: GeneratedVectorRasterRecordView | null;
  diagnostic: DiagnosticRecord | null;
}> {
  const raw = (await page.evaluate(
    bridgeAsyncScript(`return await bridge.raster(${JSON.stringify(createdTargetId)});`),
  )) as unknown;
  if (isBridgeMissing(raw)) {
    return {
      record: null,
      diagnostic: createDiagnostic(
        'BRIDGE_UNAVAILABLE',
        'Observation bridge disappeared before raster capture.',
      ),
    };
  }
  const authority = readAcceptedRasterAuthority(raw);
  if (!authority.ok || authority.record === null) {
    return {
      record: null,
      diagnostic:
        authority.diagnostic ?? createDiagnostic('RASTER_AUTHORITY_UNUSABLE', authority.detail),
    };
  }
  const record = authority.record;
  if (record.authorityKind !== 'generated-vector-projection-v1' || record.kind !== 'crossword') {
    return {
      record: null,
      diagnostic: createDiagnostic(
        'RASTER_AUTHORITY_UNUSABLE',
        'Raster authority is not a generated-vector Crossword projection.',
      ),
    };
  }
  if (record.id !== createdTargetId || !record.mounted) {
    return {
      record: null,
      diagnostic: createDiagnostic(
        'RASTER_AUTHORITY_UNUSABLE',
        'Raster authority is not the exact mounted created target.',
      ),
    };
  }
  if (
    !isWellFormedCursor(record.observation) ||
    !isWellFormedCursor(record.capture.started) ||
    !isWellFormedCursor(record.capture.completed)
  ) {
    return {
      record: null,
      diagnostic: createDiagnostic(
        'RASTER_OBSERVATION_TORN',
        'Raster observation anchors are malformed.',
      ),
    };
  }
  if (record.capture.rendererStable !== true || record.capture.boundsStable !== true) {
    return {
      record: null,
      diagnostic: createDiagnostic(
        'RASTER_OBSERVATION_TORN',
        'Raster renderer/bounds were not stable across the projection bracket.',
      ),
    };
  }
  return { record, diagnostic: null };
}

export interface CrosswordCaptureCoherenceInput {
  a0: unknown;
  a1: unknown;
  snapshot: { observation: unknown; activeLayoutId: string };
  geometry: BridgeGeometryView;
  raster: {
    record: GeneratedVectorRasterRecordView | null;
    diagnostic: DiagnosticRecord | null;
  };
  createdTargetId: string;
  activeLayoutId: string;
}

/**
 * Full coherent-capture predicate for one generated Crossword child (ADR 0017
 * R10/R14; ADR 0018 CR8). Returns the exact tear reason, or `null` when the
 * outer A0, snapshot, target geometry, raster R0/R1 and A1 anchors agree on
 * document, epoch, bridge version/generation, revision, target, renderer and
 * raster identities and the projection region agrees with the accepted target
 * geometry within `RENDER_TRANSFORM_CSS`. Only a coherent bundle earns an
 * observationId.
 */
export function evaluateCrosswordCaptureCoherence(
  input: CrosswordCaptureCoherenceInput,
): string | null {
  const { a0, a1, snapshot, geometry, raster, createdTargetId, activeLayoutId } = input;
  if (!isWellFormedCursor(a0)) return 'Anchor A0 was malformed.';
  if (!isWellFormedCursor(a1)) return 'Anchor A1 was malformed.';
  if (!isWellFormedCursor(snapshot.observation)) return 'The snapshot anchor was malformed.';
  if (!isWellFormedCursor(geometry.observation)) {
    return 'The target-geometry anchor was malformed.';
  }
  if (!cursorsEqual(a0, a1)) {
    return `Anchor A0 (${cursorKey(a0)}) and A1 (${cursorKey(a1)}) do not share one document/epoch/generation/revision.`;
  }
  const snapshotCursor = snapshot.observation as ObservationCursor;
  if (!cursorsEqual(snapshotCursor, a0)) {
    return `The snapshot stamp (${cursorKey(snapshotCursor)}) does not match anchor A0 (${cursorKey(a0)}).`;
  }
  const geometryCursor = geometry.observation as ObservationCursor;
  if (!cursorsEqual(geometryCursor, a0)) {
    return `The target-geometry stamp (${cursorKey(geometryCursor)}) does not match anchor A0 (${cursorKey(a0)}).`;
  }
  if (geometry.id !== createdTargetId) {
    return `Target geometry id "${geometry.id}" does not equal the created target "${createdTargetId}".`;
  }
  if (!geometry.mounted || geometry.visible === false) {
    return `The created target "${createdTargetId}" is not mounted and visible.`;
  }
  const viewportRect = geometry.viewportRect;
  if (viewportRect === undefined) {
    return `The created target "${createdTargetId}" published no stage-viewport geometry rect.`;
  }
  const record = raster.record;
  if (record === null || raster.diagnostic !== null) {
    return raster.diagnostic?.detail ?? 'Raster authority was unusable.';
  }
  if (record.id !== createdTargetId) {
    return `Raster target id "${record.id}" does not equal the created target "${createdTargetId}".`;
  }
  const rasterObservation = record.observation;
  const rasterStarted = record.capture.started;
  const rasterCompleted = record.capture.completed;
  if (
    !isWellFormedCursor(rasterObservation) ||
    !isWellFormedCursor(rasterStarted) ||
    !isWellFormedCursor(rasterCompleted)
  ) {
    return 'The raster observation/R0/R1 anchors were malformed.';
  }
  if (
    !cursorsEqual(rasterObservation, a0) ||
    !cursorsEqual(rasterStarted, a0) ||
    !cursorsEqual(rasterCompleted, a0)
  ) {
    return `The raster observation/R0/R1 anchors do not match anchor A0 (${cursorKey(a0)}).`;
  }
  if (record.capture.rendererStable !== true || record.capture.boundsStable !== true) {
    return 'The raster renderer/bounds were not stable across the projection bracket.';
  }
  if (record.renderer.target?.id !== createdTargetId) {
    return `Raster renderer target id "${String(record.renderer.target?.id)}" does not equal the created target "${createdTargetId}".`;
  }
  if (
    typeof geometry.renderer?.targetFingerprint !== 'string' ||
    geometry.renderer.targetFingerprint !== record.renderer.targetFingerprint
  ) {
    return 'The target-geometry renderer fingerprint does not equal the raster renderer fingerprint.';
  }
  if (record.region === null) {
    return 'The raster published no bounded projection region.';
  }
  const agreement = rasterRegionAgreesWithTarget({ region: record.region, target: viewportRect });
  if (!agreement.agrees) return agreement.detail;
  if (snapshot.activeLayoutId !== activeLayoutId) {
    return 'The active host Layout changed during the action.';
  }
  return null;
}

export async function executeCrosswordPlan(
  input: ExecuteCrosswordPlanInput,
): Promise<ExecuteCrosswordPlanResult> {
  const now = input.now ?? (() => performance.now());
  const diagnostics: DiagnosticRecord[] = [];
  const children: CrosswordChildExecutionReport[] = [];
  const childOutcomes: ChildRunOutcome[] = [];

  // ADR 0017 R4: the expected source contract is the one materialization bound
  // into the immutable plan identity. The live source is recomputed here and
  // must equal it exactly; a changed product revision fails closed instead of
  // becoming the new runtime baseline.
  const materializedSourceFingerprint = input.plan.fixture?.crosswordSourceFingerprint ?? null;
  const liveSource = ((): { ok: true; fingerprint: string } | { ok: false; detail: string } => {
    // Re-check the live source against the same explicit application root the
    // planning read used. `RunAllocation.repoRoot` is the validated app root
    // on the Diagnostic path; there is no fallback to the toolkit checkout or
    // `process.cwd()` and no rebaseline on a changed product revision.
    const read = readCrosswordSourceContract(input.allocation.repoRoot);
    return read.ok ? { ok: true, fingerprint: read.fingerprint } : { ok: false, detail: read.detail };
  })();

  let activeProfile: ReadinessProfile | null = null;
  let oracleProfileId = 'crossword-determinism-v1';
  const environmentInvalid = false;
  let browserClose: BrowserCloseOutcome = { closed: true, detail: null };
  let finalObservation: FinalExecutionObservation | null = null;

  const finish = (): ExecuteCrosswordPlanResult => {
    const report: CrosswordDriveReport = {
      schemaVersion: 1,
      outcome: 'HARNESS_BLOCKED',
      requiredChecks: [],
      harnessInvalid: true,
      diagnostics,
      evaluation: null,
      children,
      readiness: {
        profileId: activeProfile?.profileId ?? CROSSWORD_GENERATION_READINESS_PROFILE,
        timingCategory: activeProfile?.timingCategory ?? 'DERIVED_GENERATION_V1',
        deadlineMs: activeProfile?.deadlineMs ?? 8_000,
        wakeSource: 'none',
        fallbackPollCount: 0,
        watchdogWaits: 0,
        stableFrames: activeProfile?.stableFrames ?? 3,
        observedStableFrames: 0,
        idle: null,
        timings: {},
      },
      detail: 'Generated-Crossword drive did not complete.',
    };
    return {
      behavior: {
        outcome: 'HARNESS_BLOCKED',
        requiredChecks: [],
        requiredSourcesAgree: false,
        harnessInvalid: true,
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
        wakeSource: 'none',
        fallbackPollCount: 0,
        profile: {
          readinessProfileId: report.readiness.profileId,
          readinessDeadlineMs: report.readiness.deadlineMs,
          readinessStableFrames: report.readiness.stableFrames,
          readinessTimingCategory: report.readiness.timingCategory,
          oracleProfileId,
        },
        timings: {},
        detail: report.detail,
        crossword: report,
      },
      crossword: report,
      browserClose,
      environmentInvalid,
      finalObservation,
    };
  };

  if (materializedSourceFingerprint === null) {
    diagnostics.push(
      createDiagnostic(
        'CROSSWORD_SOURCE_FINGERPRINT_INVALID',
        'The immutable plan binds no accepted generated-Crossword source-contract fingerprint.',
      ),
    );
    return finish();
  }
  if (!liveSource.ok || liveSource.fingerprint !== materializedSourceFingerprint) {
    diagnostics.push(
      createDiagnostic(
        'CROSSWORD_SOURCE_DRIFT',
        liveSource.ok
          ? 'The live generated-Crossword source-contract fingerprint differs from the immutable materialized fingerprint; the accepted product revision changed after planning.'
          : `The live generated-Crossword source contract no longer matches ADR 0017 R4: ${liveSource.detail}`,
      ),
    );
    return finish();
  }
  const sourceFingerprintExpected = materializedSourceFingerprint;

  const clockInput = (input.fixture.inputs as Record<string, unknown>).clock as
    | { baselines?: readonly string[] }
    | undefined;
  const baselines = clockInput?.baselines ?? [];
  if (baselines.length !== CROSSWORD_EXECUTION_ROLES.length) {
    diagnostics.push(
      createDiagnostic(
        'CROSSWORD_CLOCK_PROFILE_INVALID',
        'The fixture does not declare one governed clock baseline per execution role.',
      ),
    );
    return finish();
  }

  const stepEntry = null;
  void stepEntry;

  // Resolve the readiness registration from the declared role contract once.
  const declaredSemanticProfile = input.fixture.semanticTargetRoles.some(
    (role) => role.semanticProfile !== undefined,
  );
  const registration = resolveReadinessProfile(CROSSWORD_GENERATION_READINESS_PROFILE);
  if (registration === null || !declaredSemanticProfile) {
    diagnostics.push(
      createDiagnostic(
        'READINESS_DEADLINE_EXCEEDED',
        'The generated-Crossword readiness profile is not registered for the declared role contract.',
      ),
    );
    return finish();
  }
  activeProfile = registration.profile;
  oracleProfileId = registration.oracleProfileId;

  for (const [index, executionRole] of CROSSWORD_EXECUTION_ROLES.entries()) {
    const baselineUtc = baselines[index] as string;
    const expectedSeed = Date.parse(baselineUtc);
    const child = await runChild({
      input,
      executionRole,
      baselineUtc,
      expectedSeed,
      notionalActiveLayoutId: null,
      sourceFingerprintExpected,
      now,
      profile: registration.profile,
    });
    childOutcomes.push(child);
    children.push(child.report);
    browserClose = child.browserClose;
    diagnostics.push(...child.report.diagnostics);
    if (child.report.outcome === 'HARNESS_BLOCKED') break;
  }

  const evidences = childOutcomes
    .map((child) => child.report.evidence)
    .filter((entry): entry is CrosswordExecutionChildInput => entry !== null);

  // The governed fixed-wall clock profile is the accepted comparison basis: the
  // Oracle evaluates the exact object the final Crossword payload also carries,
  // so no second interpretation of the clock can drift from it.
  const governedClock = {
    schemaVersion: 1,
    profileId: 'crossword-create-comparison-clock-v1',
    providerId: WALL_CLOCK_PROVIDER_ID,
    comparisonProfileId: CROSSWORD_COMPARISON_PROFILE_ID,
    baselines,
  };

  const evaluation =
    evidences.length === CROSSWORD_EXECUTION_ROLES.length
      ? evaluateCrosswordOracle({
          clock: governedClock,
          sourceFingerprintExpected,
          executions: evidences,
        })
      : null;

  // ── Executor-owned final observation handoff (ADR 0033 §1) ───────────────
  // Assemble the Crossword payload while the governed clock, expected source
  // fingerprint, raw three-child executions, Oracle primitive
  // comparison/currentness/raster facts, evidence availability/ids, and the
  // existing Crossword projection header are all in local scope. It reads no
  // legacy composite `checks`, `harnessInvalid`, or behavior outcome. A drive
  // that reached the three-child stage always yields a non-null observation,
  // including when the authority is malformed or unavailable (`evaluation` is
  // then `null` and every primitive is explicitly unusable); `null` is reserved
  // for the pre-execution refusals that return through `finish()` above.
  finalObservation = buildCrosswordFinalObservation({
    envelope: input.envelope,
    runId: input.allocation.runId,
    caseId: input.caseId,
    observationId: childOutcomes[0]?.report.observationId ?? null,
    clock: governedClock,
    sourceFingerprintExpected,
    executions: evidences,
    evaluation,
  });

  const requiredChecks: readonly LegacyCompositeCheck[] =
    evaluation?.checks ?? input.plan.requiredChecks.map((checkId) => ({ checkId, passed: false }));
  const harnessInvalid = evaluation?.harnessInvalid ?? true;
  const behaviorOutcome: Extract<Outcome, 'PASS' | 'BUG' | 'HARNESS_BLOCKED'> =
    evaluation === null || harnessInvalid
      ? 'HARNESS_BLOCKED'
      : requiredChecks.every((check) => check.passed)
        ? 'PASS'
        : 'BUG';

  const wakeSource = childOutcomes[0]?.wakeSource ?? 'none';
  const fallbackPollCount = childOutcomes.reduce(
    (total, child) => total + child.fallbackPollCount,
    0,
  );
  const watchdogWaits = childOutcomes.reduce((total, child) => total + child.watchdogWaits, 0);
  const timings: Record<string, number | null> = {};
  for (const [index, child] of childOutcomes.entries()) {
    for (const [key, value] of Object.entries(child.timings)) {
      timings[`${CROSSWORD_EXECUTION_ROLES[index]}.${key}`] = value;
    }
  }

  // ADR 0017 R13 / review finding 7: the record must carry the actual
  // target-aware idle result, never the configured requirement or a zero stub.
  const idles = childOutcomes
    .map((child) => child.idle)
    .filter((idle): idle is CrosswordIdleFacts => idle !== null);
  const observedStableFrames =
    idles.length === 0 ? 0 : Math.min(...idles.map((idle) => idle.stableFrames));
  const idle = idles[0] ?? null;

  const detail =
    behaviorOutcome === 'PASS'
      ? 'All three fresh Crossword executions passed the six required determinism checks.'
      : behaviorOutcome === 'BUG'
        ? 'The three fresh Crossword executions produced coherent evidence but a required product expectation failed.'
        : 'The generated-Crossword drive was blocked by unusable harness authority or an incomplete child execution.';

  const report: CrosswordDriveReport = {
    schemaVersion: 1,
    outcome: behaviorOutcome,
    requiredChecks,
    harnessInvalid,
    diagnostics,
    evaluation,
    children,
    readiness: {
      profileId: registration.profile.profileId,
      timingCategory: registration.profile.timingCategory,
      deadlineMs: registration.profile.deadlineMs,
      wakeSource,
      fallbackPollCount,
      watchdogWaits,
      stableFrames: registration.profile.stableFrames,
      observedStableFrames,
      idle,
      timings,
    },
    detail,
  };

  return {
    behavior: {
      outcome: behaviorOutcome,
      requiredChecks,
      requiredSourcesAgree: evaluation?.requiredSourcesAgree ?? false,
      harnessInvalid,
      diagnostics,
      resolutions: [],
      targetIds: [],
      preBehaviorRefusal: null,
      seal: null,
      bridgeContract: null,
      action: null,
      actionLogs: childOutcomes.flatMap((child) => child.actionLogs),
      cycle: null,
      observation: null,
      oracleInputs: null,
      wakeSource,
      fallbackPollCount,
      profile: {
        readinessProfileId: registration.profile.profileId,
        readinessDeadlineMs: registration.profile.deadlineMs,
        readinessStableFrames: registration.profile.stableFrames,
        readinessTimingCategory: registration.profile.timingCategory,
        oracleProfileId,
      },
      timings,
      detail,
      crossword: report,
    },
    crossword: report,
    browserClose,
    environmentInvalid,
    finalObservation,
  };
}

/**
 * The accepted Crossword final payload variant, derived from the single
 * `FinalExecutionPayload` union so this executor imports no adapter/kernel type.
 */
type CrosswordFinalPayload = Extract<
  FinalExecutionPayload,
  { evaluatorKind: 'crossword-determinism' }
>;

/**
 * Projects every declared required-authoritative evidence id with its actual
 * availability. A `current` Oracle primitive authority yields `authoritative`;
 * a malformed/unavailable authority yields `malformed`. No evidence id is
 * invented and no legacy composite check is read.
 */
function crosswordEvidenceFacts(
  evidenceIds: readonly string[],
  authority: 'current' | 'malformed',
): CrosswordFinalPayload['evidence'] {
  const availability = authority === 'current' ? 'authoritative' : 'malformed';
  return evidenceIds.map((evidenceId) => ({ evidenceId, availability }));
}

/** Exact ordered word equality, mirroring the accepted comparison contract. */
function crosswordWordOrderEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((word, index) => word === right[index]);
}

/**
 * Builds the existing check-free Crossword nested-projection header from the
 * accepted three-child evaluation the executor actually captured; the façade
 * attaches the evaluated checks. It is `null` whenever the accepted comparison
 * or the complete three-child set is unavailable, so an incomplete drive never
 * fabricates a projection. The comparison facts are read from the raw accepted
 * children, never from a legacy check or the aggregate harness flag.
 */
function buildCrosswordProjectionHeader(
  evaluation: CrosswordOracleEvaluation | null,
  actionCycleRef: string,
): CrosswordProjectionHeader | null {
  if (evaluation === null || evaluation.comparison === null || evaluation.executions.length !== 3) {
    return null;
  }
  const byRole = new Map(
    evaluation.executions.map((child) => [child.executionRole, child] as const),
  );
  const a1 = byRole.get('A1');
  const a2 = byRole.get('A2');
  const b = byRole.get('B');
  if (a1 === undefined || a2 === undefined || b === undefined) return null;
  return {
    schemaVersion: FINAL_NESTED_PROJECTION_SCHEMA_VERSION,
    family: 'crossword',
    providerId: WALL_CLOCK_PROVIDER_ID,
    namespace: WALL_CLOCK_NAMESPACE,
    comparisonProfileId: CROSSWORD_COMPARISON_PROFILE_ID,
    executions: [a1, a2, b].map((child) => ({
      executionRole: child.executionRole,
      clockBaselineUtc: child.clock.baselineUtc,
      expectedSeed: child.clock.expectedSeed,
      actualSeed: child.actualSeed,
      hostLayoutId: child.currentness.hostLayoutId,
      createdTargetId: child.currentness.createdTargetId,
      words: child.words,
      semanticDigest: child.semanticDigest,
      actionCycleRef,
    })),
    comparison: {
      sameSeedEqual: a1.actualSeed === a2.actualSeed,
      sameWordsEqual: crosswordWordOrderEqual(a1.words, a2.words),
      sameSemanticDigestEqual: a1.semanticDigest === a2.semanticDigest,
      controlSeedDifferent: a1.actualSeed !== b.actualSeed,
      controlWordsEqual: crosswordWordOrderEqual(a1.words, b.words),
      controlSemanticDigestDifferent: a1.semanticDigest !== b.semanticDigest,
    },
  };
}

/**
 * Assembles the immutable, envelope-bound Crossword final observation (ADR 0033
 * §1). It binds the one Action Cycle identity derived exclusively from the exact
 * planning envelope and returns the payload assembled from the executor's own
 * captured primitives; it reads no legacy check, harness flag, or outcome.
 */
function buildCrosswordFinalObservation(input: {
  readonly envelope: MaterializedExecutionEnvelopeV1;
  readonly runId: string;
  readonly caseId: string;
  readonly observationId: string | null;
  readonly clock: unknown;
  readonly sourceFingerprintExpected: string;
  readonly executions: readonly unknown[];
  readonly evaluation: CrosswordOracleEvaluation | null;
}): FinalExecutionObservation {
  const actionCycleId = `final:${input.runId}:${input.caseId}:crossword-determinism`;
  const payload: FinalExecutionPayload = {
    evaluatorKind: 'crossword-determinism',
    projection: buildCrosswordProjectionHeader(input.evaluation, actionCycleId),
    clock: input.clock,
    sourceFingerprintExpected: input.sourceFingerprintExpected,
    executions: input.executions,
    oracle:
      input.evaluation === null
        ? null
        : {
            primitiveFacts: input.evaluation.primitiveFacts,
            comparison: input.evaluation.comparison,
            diagnostics: input.evaluation.diagnostics,
          },
    evidence: crosswordEvidenceFacts(
      input.envelope.correctnessProfile.requiredAuthoritativeEvidence,
      input.evaluation === null ? 'malformed' : input.evaluation.primitiveFacts.authority,
    ),
  };
  return Object.freeze({
    envelope: input.envelope,
    actionCycle: bindFinalActionCycleIdentity({ envelope: input.envelope, actionCycleId }),
    payload: Object.freeze(payload),
    observationId: input.observationId,
  });
}

async function runChild(run: ChildRunInput): Promise<ChildRunOutcome> {
  const { input, executionRole, baselineUtc, expectedSeed, sourceFingerprintExpected, profile } =
    run;
  const diagnostics: DiagnosticRecord[] = [];
  const now = run.now;
  const timings: Record<string, number | null> = {};
  let session: BrowserSession | null = null;
  let gate: CorrelatedGateResult | null = null;
  let wakeSource: WakeSource = 'none';
  let fallbackPollCount = 0;
  let watchdogWaits = 0;
  let actionLogs: readonly StepActionLog[] = [];
  let tornRecaptureCount = 0;

  try {
    session = await (input.openPage ?? openFreshPage)({
      baseUrl: input.allocation.baseUrl,
      route: CHILD_ROUTE,
      environment: input.environment,
      navigationTimeoutMs: 60_000,
      wallClockBaselineUtc: baselineUtc,
    });
    const { page } = session;
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

    // ── Seal the Crossword-free host constructor ────────────────────────────
    const setupStatus = await readSetupStatus(page);
    if (setupStatus === null) {
      return failedChild(executionRole, 'Setup boundary exposed no status projection.', [
        ...diagnostics,
        createDiagnostic('SEAL_NOT_CONFIRMED', 'The setup boundary exposed no status projection.'),
      ]);
    }
    const authorization = createSetupAuthorization({
      runId: input.allocation.runId,
      caseId: input.caseId,
      origin: new URL(input.allocation.baseUrl).origin,
      documentId: setupStatus.document.documentId,
    });
    await deliverSetupAuthorization(page, authorization);
    // The governed wall-clock profile is harness metadata; the host constructor
    // only accepts its declared artwork inputs. Strip the harness-only `clock`
    // key before invoking the Crossword-free host constructor.
    const { clock: _harnessClock, ...constructorInputs } = input.fixture.inputs as Record<
      string,
      unknown
    >;
    void _harnessClock;
    const constructOutcome = await invokeSetupConstructor(page, {
      constructorId: input.fixture.constructorId,
      constructorVersion: input.fixture.constructorVersion,
      scope: { runId: input.allocation.runId, caseId: input.caseId },
      inputs: structuredClone(constructorInputs),
    });
    const refusal = sealFailure(constructOutcome);
    if (refusal !== null) {
      return failedChild(executionRole, `Setup did not seal: ${refusal}`, [
        ...diagnostics,
        createDiagnostic('SEAL_NOT_CONFIRMED', refusal),
      ]);
    }
    if (!constructOutcome.ok) {
      return failedChild(executionRole, 'Setup did not seal.', [
        ...diagnostics,
        createDiagnostic('SEAL_NOT_CONFIRMED', 'Setup did not return a seal record.'),
      ]);
    }
    const sealRecord: SetupSealRecord = constructOutcome.sealRecord;
    const activeLayoutId = sealRecord.semanticPrecondition.activeLayoutId;

    // ── Pre-action: resolve only the host and prove the zero-Crossword host ──
    const preElementsRaw = (await page.evaluate(bridgeCallScript('return bridge.elements();'))) as
      | BridgeElementsView
      | { __bridgeMissing: true };
    if (isBridgeMissing(preElementsRaw)) {
      return failedChild(executionRole, 'Observation bridge unavailable after seal.', [
        ...diagnostics,
        createDiagnostic('BRIDGE_UNAVAILABLE', 'Observation bridge disappeared after the seal.'),
      ]);
    }
    const preElements = toAdapterFacts(preElementsRaw.elements);
    const preActionRoles = rolesForPhase(input.fixture.semanticTargetRoles, 'pre-action');
    const preResolutions = input.adapter.resolveTargets({
      phase: 'pre-action',
      roles: input.fixture.semanticTargetRoles,
      elements: preElements,
      activeLayoutId,
    });
    const hostResolution = preResolutions[0];
    if (
      preResolutions.length !== preActionRoles.length ||
      preResolutions.some((resolution) => resolution.status !== 'resolved') ||
      hostResolution === undefined ||
      hostResolution.target === null
    ) {
      return failedChild(
        executionRole,
        'The pre-action host did not resolve to exactly one active product Layout.',
        [
          ...diagnostics,
          createDiagnostic(
            'TARGET_UNRESOLVED',
            'The pre-action host did not resolve to exactly one active product Layout.',
          ),
        ],
      );
    }

    const preSnapshot = (await page.evaluate(
      bridgeCallScript('return bridge.snapshot();'),
    )) as BridgeSnapshotView;
    const productLayouts = preSnapshot.layoutItems.filter((layout) => layout.isCanvas !== true);
    const allPreCrosswords = allCrosswordIds(preElementsRaw.elements);
    const selectedCrosswords = preElementsRaw.elements.filter(
      (element) => element.kind === 'crossword' && element.selected === true,
    );
    const hostProblems: string[] = [];
    if (productLayouts.length !== 2) {
      hostProblems.push(`expected exactly two product Layouts, found ${productLayouts.length}`);
    }
    if (allPreCrosswords.length !== 0) {
      hostProblems.push(`expected zero Crossword layers, found ${allPreCrosswords.length}`);
    }
    if (selectedCrosswords.length !== 0) {
      hostProblems.push('a Crossword layer was selected before the action');
    }
    if (
      preSnapshot.history.pastDepth !== 0 ||
      preSnapshot.history.futureDepth !== 0 ||
      preSnapshot.history.baselineClean !== true
    ) {
      hostProblems.push(
        `history baseline was not clean (past=${preSnapshot.history.pastDepth}, future=${preSnapshot.history.futureDepth})`,
      );
    }
    if (preSnapshot.activeLayoutId !== activeLayoutId) {
      hostProblems.push('the sealed active Layout changed before the action');
    }
    if (hostProblems.length > 0) {
      return failedChild(
        executionRole,
        `Pre-action host precondition failed: ${hostProblems.join('; ')}.`,
        [
          ...diagnostics,
          createDiagnostic(
            'TARGET_UNRESOLVED',
            `Pre-action host precondition failed: ${hostProblems.join('; ')}.`,
          ),
        ],
      );
    }

    const baseline: AdapterResolutionBaseline = buildAdapterResolutionBaseline({
      resolutions: preResolutions,
      elements: preElements,
      activeLayoutId,
    });
    const preHostIds = new Set((baseline.activeLayoutChildIdsByKind['crossword'] ?? []).slice());
    const preAllCrosswordIds = new Set(allPreCrosswords);

    // ── Arm readiness and dispatch the exact native More → Crossword path ───
    const baselineCursor = (await page.evaluate(
      bridgeCallScript('return bridge.cursor();'),
    )) as ObservationCursor;
    if (!isWellFormedCursor(baselineCursor)) {
      return failedChild(executionRole, 'The pre-action observation cursor was malformed.', [
        ...diagnostics,
        createDiagnostic('BRIDGE_CURSOR_INVALID', 'The pre-action cursor was malformed.'),
      ]);
    }
    // ADR 0018 CR8: one non-extending Node-monotonic 8-second deadline starts
    // immediately before the first native input and encloses both control
    // activations, the signal-first transition, target resolution, target-aware
    // idle, fonts, capture/hash, and bounded torn recapture. It never resets.
    timings.armedAtMs = 0;
    const armedAt = now();
    const deadlineAt = armedAt + profile.deadlineMs;

    let moreActivated = false;
    const actionOutcome = await withinDeadline(
      executeWorkflowSteps({
        steps: input.workflowSteps,
        operation: input.intent.operations[0],
        resolutions: preResolutions,
        points: {},
        handlers: {
          pointerDrag: async () => ({ ok: false, detail: 'pointer.drag is not used by create' }),
          pointerClick: async () => ({ ok: false, detail: 'pointer.click is not used by create' }),
          controlActivate: async (request) => {
            if (moreActivated) {
              // The visible Element presets region is required before the
              // Crossword control is activated (ADR 0017 R9).
              const region = page.getByRole('region', { name: 'Element presets', exact: true });
              const regions = await region.all();
              let visible = 0;
              for (const candidate of regions) {
                if (await candidate.isVisible()) visible += 1;
              }
              if (regions.length !== 1 || visible !== 1) {
                return {
                  ok: false,
                  code: 'PUBLIC_CONTROL_UNAVAILABLE',
                  detail: `The "Element presets" region was not exactly one visible region (matches=${regions.length}, visible=${visible}).`,
                };
              }
            }
            const activated = await activateControl({ page, accessibleName: request.control });
            if (activated.ok && request.control === 'More') moreActivated = true;
            return { ok: activated.ok, detail: activated.detail };
          },
          keyboardPress: async () => ({ ok: false, detail: 'keyboard.press is not used' }),
          fileInputSet: async () => ({ ok: false, detail: 'fileInput.set is not used' }),
        },
      }),
      deadlineAt,
      now,
      'Native More → Crossword control activation',
    );
    if (!actionOutcome.ok) {
      return failedChild(
        executionRole,
        actionOutcome.detail,
        [...diagnostics, createDiagnostic('READINESS_DEADLINE_EXCEEDED', actionOutcome.detail)],
        { actionLogs },
      );
    }
    const actionResult = actionOutcome.value;
    actionLogs = actionResult.logs;
    if (!actionResult.ok) {
      return failedChild(
        executionRole,
        `Native create action was refused: ${actionResult.finding.detail}`,
        [...diagnostics, actionResult.finding],
        { actionLogs },
      );
    }
    timings.actionCompletedAtMs = Math.round(now() - armedAt);

    // ── Signal-first causal transition ─────────────────────────────────────
    gate = await awaitCausalTransition({
      profile,
      now,
      armedAt,
      armCursor: baselineCursor,
      waitForChange: async (after, timeoutMs): Promise<WaitForChangeOutcome> =>
        (await page.evaluate(
          bridgeAsyncScript(
            `return await bridge.waitForChange({ after: ${JSON.stringify(after)}, timeoutMs: ${timeoutMs} });`,
          ),
        )) as WaitForChangeOutcome,
      readCursor: async () =>
        (await page.evaluate(bridgeCallScript('return bridge.cursor();'))) as ObservationCursor,
      evaluateCausalTransition: async (cursor): Promise<CausalPredicateResult> => {
        if (cursor.documentId !== baselineCursor.documentId) {
          return { satisfied: false, detail: 'Document identity changed during the action.' };
        }
        if (cursor.bridgeGeneration !== baselineCursor.bridgeGeneration) {
          return { satisfied: false, detail: 'Bridge generation changed during the action.' };
        }
        const raw = (await page.evaluate(bridgeCallScript('return bridge.elements();'))) as
          | BridgeElementsView
          | { __bridgeMissing: true };
        if (isBridgeMissing(raw)) {
          return { satisfied: false, detail: 'Bridge disappeared during the action.' };
        }
        const postHostIds = activeHostCrosswordIds(raw.elements, activeLayoutId);
        const postAll = allCrosswordIds(raw.elements);
        const newIds = postHostIds.filter((id) => !preHostIds.has(id));
        const newOutsideHost = postAll.filter(
          (id) => !preAllCrosswordIds.has(id) && !postHostIds.includes(id),
        );
        if (newOutsideHost.length > 0) {
          return { satisfied: false, detail: 'A Crossword appeared outside the active host.' };
        }
        if (newIds.length !== 1) {
          return {
            satisfied: false,
            detail: `Expected exactly one new active-host Crossword, observed ${newIds.length}.`,
          };
        }
        return { satisfied: true, detail: `New active-host Crossword ${newIds[0]}.` };
      },
    });
    wakeSource = gate.wakeSource;
    fallbackPollCount = gate.fallbackPollCount;
    watchdogWaits = gate.watchdogWaits;
    timings.transitionAtMs = Math.round(now() - armedAt);
    if (gate.status !== 'transition') {
      return failedChild(
        executionRole,
        `The causal create transition was not accepted (${gate.status}).`,
        [
          ...diagnostics,
          createDiagnostic(
            gate.status === 'invalidated' ? 'UNUSABLE_EVIDENCE' : 'READINESS_DEADLINE_EXCEEDED',
            `The causal create transition was not accepted (${gate.status}).`,
          ),
        ],
        { gate, wakeSource, fallbackPollCount, watchdogWaits, actionLogs, timings },
      );
    }

    // ── Post-action: exact active-host set-difference resolution ────────────
    const postElementsRaw = (await page.evaluate(bridgeCallScript('return bridge.elements();'))) as
      | BridgeElementsView
      | { __bridgeMissing: true };
    if (isBridgeMissing(postElementsRaw)) {
      return failedChild(executionRole, 'Observation bridge unavailable after the action.', [
        ...diagnostics,
        createDiagnostic('BRIDGE_UNAVAILABLE', 'Observation bridge disappeared after the action.'),
      ]);
    }
    const postResolutions = input.adapter.resolveTargets({
      phase: 'post-action',
      roles: input.fixture.semanticTargetRoles,
      elements: toAdapterFacts(postElementsRaw.elements),
      activeLayoutId,
      baseline,
    });
    const created = postResolutions.find((resolution) => resolution.status === 'resolved');
    if (
      postResolutions.length !== 1 ||
      created === undefined ||
      created.target === null ||
      created.matchedElementIds.length !== 1
    ) {
      return failedChild(
        executionRole,
        'The created target was not resolved from the exact active-host set difference.',
        [
          ...diagnostics,
          createDiagnostic(
            'TARGET_AMBIGUOUS',
            'The created target was not resolved from the exact active-host set difference.',
          ),
        ],
        { gate, wakeSource, fallbackPollCount, watchdogWaits, actionLogs, timings },
      );
    }
    const createdTargetId = created.target.elementId;

    // ── Target-aware idle + fonts inside the one deadline (ADR 0017 R13) ────
    const idleOutcome = await withinDeadline(
      page.evaluate(
        bridgeAsyncScript(
          `return await bridge.waitForIdle({ targets: ${JSON.stringify([createdTargetId])}, stableFrames: ${profile.stableFrames}, timeoutMs: ${Math.max(0, Math.round(deadlineAt - now()))} });`,
        ),
      ),
      deadlineAt,
      now,
      'Target-aware waitForIdle',
    );
    if (!idleOutcome.ok) {
      return failedChild(
        executionRole,
        idleOutcome.detail,
        [...diagnostics, createDiagnostic('READINESS_DEADLINE_EXCEEDED', idleOutcome.detail)],
        { gate, wakeSource, fallbackPollCount, watchdogWaits, actionLogs, timings },
      );
    }
    const idleRaw = idleOutcome.value as BridgeIdleResultView | { __bridgeMissing: true };
    if (isBridgeMissing(idleRaw) || idleRaw.idle !== true) {
      const detail = 'The bridge published no accepted target-aware idle result.';
      return failedChild(
        executionRole,
        detail,
        [...diagnostics, createDiagnostic('UNUSABLE_EVIDENCE', detail)],
        { gate, wakeSource, fallbackPollCount, watchdogWaits, actionLogs, timings },
      );
    }
    const idleObservation = idleRaw.observation;
    if (
      typeof idleRaw.stableFrames !== 'number' ||
      idleRaw.stableFrames < profile.stableFrames ||
      !isWellFormedCursor(idleObservation) ||
      idleObservation.documentId !== baselineCursor.documentId ||
      idleObservation.bridgeGeneration !== baselineCursor.bridgeGeneration
    ) {
      const detail =
        'The target-aware idle result was not a fully stable, coherent readiness fact.';
      return failedChild(
        executionRole,
        detail,
        [...diagnostics, createDiagnostic('UNUSABLE_EVIDENCE', detail)],
        { gate, wakeSource, fallbackPollCount, watchdogWaits, actionLogs, timings },
      );
    }
    const idle: CrosswordIdleFacts = {
      targetCount: 1,
      stableFrames: idleRaw.stableFrames,
      waitedMs: typeof idleRaw.waitedMs === 'number' ? idleRaw.waitedMs : -1,
      observationRevision: idleObservation.revision,
    };
    const fontsOutcome = await withinDeadline(
      page.evaluate('document.fonts.ready.then(() => true)'),
      deadlineAt,
      now,
      'document.fonts.ready',
    );
    if (!fontsOutcome.ok) {
      return failedChild(
        executionRole,
        fontsOutcome.detail,
        [...diagnostics, createDiagnostic('READINESS_DEADLINE_EXCEEDED', fontsOutcome.detail)],
        { gate, wakeSource, fallbackPollCount, watchdogWaits, actionLogs, timings },
      );
    }
    timings.quiescentAtMs = Math.round(now() - armedAt);

    // ── Coherent A0 → snapshot → geometry → raster(R0/R1) → A1 capture ──────
    // One complete predicate over document, epoch, bridge version/generation,
    // revision, target, renderer and raster identities (ADR 0017 R10). A torn
    // candidate receives no observationId and may be recaptured only inside the
    // original deadline; the loop never extends it.
    let acceptedCapture: {
      a0: ObservationCursor;
      snapshot: BridgeSnapshotView;
      geometry: BridgeGeometryView;
      raster: GeneratedVectorRasterRecordView;
    } | null = null;
    let lastTearDetail = 'no capture attempt completed';
    for (;;) {
      if (now() >= deadlineAt) {
        const detail = `Coherent capture did not settle before the readiness deadline (${lastTearDetail}).`;
        return failedChild(
          executionRole,
          detail,
          [...diagnostics, createDiagnostic('READINESS_DEADLINE_EXCEEDED', detail)],
          { gate, wakeSource, fallbackPollCount, watchdogWaits, actionLogs, timings },
        );
      }
      const a0Read = await withinDeadline(
        page.evaluate(bridgeCallScript('return bridge.cursor();')),
        deadlineAt,
        now,
        'Anchor A0',
      );
      const snapshotRead = await withinDeadline(
        page.evaluate(bridgeCallScript('return bridge.snapshot();')),
        deadlineAt,
        now,
        'Snapshot',
      );
      const geometryRead = await withinDeadline(
        page.evaluate(
          bridgeCallScript(`return bridge.geometry(${JSON.stringify(createdTargetId)});`),
        ),
        deadlineAt,
        now,
        'Target geometry',
      );
      const rasterRead = await withinDeadline(
        readGeneratedVectorRaster(page, createdTargetId),
        deadlineAt,
        now,
        'Raster acquisition',
      );
      const a1Read = await withinDeadline(
        page.evaluate(bridgeCallScript('return bridge.cursor();')),
        deadlineAt,
        now,
        'Anchor A1',
      );
      const deadlineFailures = [
        a0Read.ok ? null : a0Read.detail,
        snapshotRead.ok ? null : snapshotRead.detail,
        geometryRead.ok ? null : geometryRead.detail,
        rasterRead.ok ? null : rasterRead.detail,
        a1Read.ok ? null : a1Read.detail,
      ].filter((detail): detail is string => detail !== null);
      if (deadlineFailures.length > 0) {
        const detail = deadlineFailures[0] as string;
        return failedChild(
          executionRole,
          detail,
          [...diagnostics, createDiagnostic('READINESS_DEADLINE_EXCEEDED', detail)],
          { gate, wakeSource, fallbackPollCount, watchdogWaits, actionLogs, timings },
        );
      }
      if (!a0Read.ok || !snapshotRead.ok || !geometryRead.ok || !rasterRead.ok || !a1Read.ok) {
        continue;
      }
      const tear = evaluateCrosswordCaptureCoherence({
        a0: a0Read.value,
        a1: a1Read.value,
        snapshot: snapshotRead.value as BridgeSnapshotView,
        geometry: geometryRead.value as BridgeGeometryView,
        raster: rasterRead.value,
        createdTargetId,
        activeLayoutId,
      });
      if (tear === null) {
        acceptedCapture = {
          a0: a0Read.value as ObservationCursor,
          snapshot: snapshotRead.value as BridgeSnapshotView,
          geometry: geometryRead.value as BridgeGeometryView,
          raster: rasterRead.value.record as GeneratedVectorRasterRecordView,
        };
        break;
      }
      tornRecaptureCount += 1;
      lastTearDetail = tear;
    }
    timings.capturedAtMs = Math.round(now() - armedAt);

    const {
      a0,
      snapshot,
      geometry,
      raster: rasterRecord,
    } = acceptedCapture as NonNullable<typeof acceptedCapture>;

    // Read the exact generated Crossword config from the accepted snapshot.
    const createdLayer = snapshot.layoutItems
      .flatMap((layout) => layout.layers ?? [])
      .find((layer) => layer.id === createdTargetId);
    const crossword = (createdLayer?.crossword ?? createdLayer?.config?.crossword) as
      | { words?: unknown; layout?: unknown; generationSeed?: unknown }
      | undefined;
    const words = crossword?.words;
    const actualSeed = crossword?.generationSeed;
    const histogramRaw = crossword?.layout;

    if (
      crossword === undefined ||
      !Array.isArray(words) ||
      !words.every((word) => typeof word === 'string') ||
      typeof actualSeed !== 'number' ||
      !Number.isSafeInteger(actualSeed)
    ) {
      return failedChild(
        executionRole,
        'The created Crossword layer did not expose a complete words/seed projection.',
        [
          ...diagnostics,
          createDiagnostic(
            'CROSSWORD_SEMANTIC_MALFORMED',
            'The created Crossword layer did not expose a complete words/seed projection.',
          ),
        ],
        { gate, wakeSource, fallbackPollCount, watchdogWaits, actionLogs, timings },
      );
    }
    const structural = crosswordSemanticPayloadFromLayerShape(
      { words, layout: histogramRaw },
      words as readonly string[],
    );
    if (!structural.ok || structural.payload === null) {
      return failedChild(
        executionRole,
        'The created Crossword layout was structurally inconsistent.',
        [
          ...diagnostics,
          createDiagnostic(
            'CROSSWORD_SEMANTIC_MALFORMED',
            structural.findings.map((finding) => finding.detail).join('; ') ||
              'The created Crossword layout was structurally inconsistent.',
          ),
        ],
        { gate, wakeSource, fallbackPollCount, watchdogWaits, actionLogs, timings },
      );
    }
    const semantic = structural.payload;
    const semanticDigest = crosswordSemanticDigest(semantic);
    const hostCountBefore = preHostIds.size;
    const hostCountAfter = activeHostCrosswordIds(postElementsRaw.elements, activeLayoutId).length;
    const historyAfter = snapshot.history.pastDepth;
    const geometryRect = geometry.viewportRect as {
      x: number;
      y: number;
      width: number;
      height: number;
    };
    const targetGeometry: CrosswordTargetGeometryV1 = {
      id: geometry.id,
      x: geometryRect.x,
      y: geometryRect.y,
      width: geometryRect.width,
      height: geometryRect.height,
    };

    const evidence: CrosswordExecutionChildInput = {
      schemaVersion: 1,
      executionRole,
      clock: {
        providerId: 'playwright-clock-fixed-wall-v1',
        namespace: 'crossword.create.date-now.v1',
        baselineUtc,
        expectedSeed,
      },
      sourceContractFingerprint: sourceFingerprintExpected,
      transition: {
        preActionHostCrosswordCount: hostCountBefore,
        postActionHostCrosswordCount: hostCountAfter,
        newTargetCount: 1,
        historyPastDepthBefore: 0,
        historyPastDepthAfter: historyAfter,
      },
      currentness: {
        schemaVersion: 1,
        documentId: a0.documentId,
        documentEpoch: a0.documentEpoch,
        bridgeGeneration: a0.bridgeGeneration,
        observationRevision: a0.revision,
        actionEpochId: `${a0.documentId}:${gate.cursor?.revision ?? a0.revision}`,
        hostLayoutId: activeLayoutId,
        createdTargetId,
        generationSeed: actualSeed,
        wordsFingerprint: crosswordWordsFingerprint(semantic.words),
        semanticLayoutDigest: semanticDigest,
        rendererFingerprint: rasterRecord.renderer.targetFingerprint,
        rasterFingerprint: rasterRecord.rasterFingerprint,
      },
      actualSeed,
      words: semantic.words,
      layout: histogramRaw,
      semanticDigest,
      targetGeometry,
      raster: rasterRecord,
      observationId: `${executionRole}:${a0.documentId}:${a0.revision}`,
      tornRecaptureCount,
      contextClosed: true,
    };

    const closed = await closeBrowserSession(session);
    session = null;
    if (!closed.closed) {
      diagnostics.push(
        createDiagnostic(
          'UNUSABLE_EVIDENCE',
          `Child cleanup failed: ${closed.detail ?? 'unknown'}`,
        ),
      );
      return failedChild(
        executionRole,
        `Child browser cleanup failed: ${closed.detail ?? 'unknown'}`,
        diagnostics,
        {
          gate,
          wakeSource,
          fallbackPollCount,
          watchdogWaits,
          actionLogs,
          timings,
          browserClose: closed,
          idle,
        },
      );
    }

    return {
      report: {
        executionRole,
        outcome: 'PASS',
        evidence,
        observationId: evidence.observationId,
        tornRecaptureCount,
        contextClosed: true,
        idle,
        detail: `Child ${executionRole} created exactly one active-host Crossword and captured coherent evidence.`,
        diagnostics,
      },
      cursor: a0,
      wakeSource,
      fallbackPollCount,
      watchdogWaits,
      gate,
      actionLogs,
      timings,
      browserClose: closed,
      idle,
    };
  } catch (error) {
    const detail = `Generated-Crossword child ${executionRole} failed: ${(error as Error).message}`;
    diagnostics.push(createDiagnostic('RUNTIME_LAUNCH_FAILED', detail));
    return failedChild(executionRole, detail, diagnostics, { gate, actionLogs, timings });
  } finally {
    if (session !== null) {
      const closed = await closeBrowserSession(session);
      if (!closed.closed) {
        diagnostics.push(
          createDiagnostic(
            'UNUSABLE_EVIDENCE',
            `Child cleanup failed: ${closed.detail ?? 'unknown'}`,
          ),
        );
      }
    }
  }
}

// The three-child orchestration is selected by the closed role-timing
// discriminant of the resolved fixture, never by a Subject/scenario branch.
export const fixtureRequiresSequentialChildren = fixtureHasPostActionRoles;
