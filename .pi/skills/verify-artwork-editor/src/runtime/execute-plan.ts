import path from 'node:path';

import type { TargetResolution, SubjectAdapter } from '../contracts/adapter';
import { targetResolutionDiagnostic } from '../contracts/adapter';
import type { CaseIntent, ExecutionPlan } from '../contracts/case-model';
import {
  createDiagnostic,
  type DiagnosticCode,
  type DiagnosticRecord,
} from '../contracts/diagnostics';
import type { ObservationCursor, WaitForChangeOutcome, WakeSource } from '../contracts/observation';
import type { ActionCycleCorrectnessIdentity } from '../contracts/correctness';
import type {
  FINAL_NESTED_PROJECTION_SCHEMA_VERSION,
  FinalCrosswordComparisonV4,
  FinalCrosswordExecutionProjectionV4,
  FinalHistoryProjectionV4,
  FinalImageCycleProjectionV4,
  FinalRestoreProjectionV4,
} from '../contracts/final-record-v4';
import type {
  OrdinaryTextLiveFactAdapterInput,
  WarpedTextLiveFactAdapterInput,
} from '../adapters/text-live-facts';
import type { NestedObjectLiveFactAdapterInput } from '../adapters/object-live-facts';
import type { ImageLiveFactAdapterInput } from '../adapters/image-live-facts';
import type { CrosswordLiveFactAdapterInput } from '../adapters/crossword-live-facts';
import type { HistoryLiveFactAdapterInput } from '../adapters/history-live-facts';
import type { RestoreLiveFactAdapterInput } from '../adapters/restore-live-facts';
import type { MaterializedExecutionEnvelopeV1 } from '../planner/execution-materialization';
import type { EnvironmentCell, RunAllocation } from '../contracts/runtime';
import type { BindingFixture } from '../contracts/fixtures';
import {
  OBSERVATION_BRIDGE_READ_ONLY_METHODS,
  OBSERVATION_GLOBAL_NAME,
  SETUP_GLOBAL_NAME,
  SETUP_ROUTE,
} from '../contracts/seam';
import { OBSERVATION_BRIDGE_VERSION } from '../contracts/seam';
import {
  deriveNestedCanonicalChain,
  NESTED_OBJECT_AFFINE_CHAIN_KIND,
  parseNestedGeometryV3,
} from '../contracts/geometry-v3';
/**
 * Private/deprecated legacy composite check mirror (ADR 0032 §E3-S1). It is
 * retained only so this active runtime executor producer compiles until the
 * E3-S2 architecture switch consumes the additive `primitiveFacts` the Action
 * Cycle exposes through `ActionCycleResult`. It is deliberately declared locally
 * (never imported from `contracts/execution`) so the producer no longer reaches
 * the legacy boolean result authority, and it is never the source of a final
 * status.
 *
 * @deprecated E3-S2 removes the legacy composite authority entirely.
 */
interface LegacyCompositeCheck {
  readonly checkId: string;
  readonly passed: boolean;
}
import type { Outcome } from '../contracts/discriminants';
import { classifyOutcome } from './outcomes';
import {
  bindFinalActionCycleIdentity,
  runActionCycle,
  type ActionCycleResult,
  type ActionCycleTimings,
  type ActionDispatchResult,
} from './action-cycle';
import { readMinimumDelta } from '../oracles/evaluate';
import { findCanonicalPosition, renderedTransformPosition } from '../oracles/geometry';
import {
  ACTION_CYCLE_V1_PROFILE,
  type CausalPredicateResult,
  type ReadinessProfile,
} from '../readiness/correlated-gate';
import { resolveReadinessProfile } from '../readiness/profile-registry';
import type {
  CoherentObservation,
  StampedGeometryView,
  StampedSnapshotView,
} from '../readiness/coherent-capture';
import type { WorkflowStep } from '../contracts/workflows';
import { executeWorkflowSteps, type StepActionLog } from '../workflows/execute';
import { executeImagePlan, type ImageDriveReport } from './execute-image-plan';
import {
  executeHistoryPlan,
  historyWorkflowMatches,
  type HistoryDriveReport,
} from './execute-history-plan';
import {
  executeRestorePlan,
  restoreWorkflowMatches,
  type RestoreDriveReport,
} from './execute-restore-plan';
import {
  executeCrosswordPlan,
  fixtureRequiresSequentialChildren,
  type CrosswordDriveReport,
} from './execute-crossword-plan';
import { pointerDrag } from '../browser/primitives';
import { buildDoctorBridgeInspectionScript } from '../browser/doctor';
import { closeBrowserSession, type BrowserCloseOutcome } from '../browser/doctor';
import { openFreshPage, type BrowserSession } from '../browser/launch';
import {
  createSetupAuthorization,
  deliverSetupAuthorization,
  invokeSetupConstructor,
  readSetupStatus,
  type SetupConstructorOutcome,
} from '../browser/seam';
import type { SetupNormalizationRefusalEvidence, SetupSealRecord } from '../contracts/seam';

/**
 * Diagnostic drive execution over the compiled plan phases (WP5 Slice 5-A).
 *
 * This module owns the one real drive: it opens one fresh Chromium context on
 * the owned server, applies the Doctor v3 bridge-contract inspection inline as
 * the precondition (no second browser), seals the existing two-layout Text
 * constructor through the one-shot setup boundary, resolves exactly one
 * active-layout Text target, verifies its live hit point, records the
 * pre-action baseline, arms the readiness cursor, dispatches the real native
 * pointer drag, and then delegates to the signal-first action cycle for
 * readiness, target-aware quiescence, coherent capture, and Oracle evaluation.
 *
 * No store mutation happens after the seal: the only product mutation is the
 * native pointer drag the case claims.
 */

export interface DiagnosticBridgeElements {
  observation: ObservationCursor;
  elements: readonly { id: string; kind: string; parentId: string | null; mounted: boolean }[];
}

export interface DiagnosticBridgeSnapshot extends StampedSnapshotView {
  observation: ObservationCursor;
  layoutItems: unknown;
  activeLayoutId: string;
  selectedLayoutIds: readonly string[];
  history: { pastDepth: number; futureDepth: number; baselineClean: boolean };
}

export interface ExecutePlanInput {
  allocation: RunAllocation;
  caseId: string;
  intent: CaseIntent;
  plan: ExecutionPlan;
  /**
   * The exact `MaterializedExecutionEnvelopeV1` compiled once during planning.
   * The executor places this exact object by reference in
   * `FinalExecutionObservation.envelope`; it never recompiles, looks up, or
   * reconstructs a profile.
   */
  envelope: MaterializedExecutionEnvelopeV1;
  adapter: SubjectAdapter;
  fixture: BindingFixture;
  workflowSteps: readonly WorkflowStep[];
  environment: EnvironmentCell;
  /**
   * The validated FE-owned product-meaning provider injected by Diagnostic
   * preflight (ADR 0118) and forwarded unchanged to the history/restore drives.
   * Launch/non-meaning drives ignore it.
   */
  meaningProvider: import('../contracts/product-meaning-provider').ProductMeaningProviderV1;
  /** Resolved Slice 5-C resources, present only for a raster/image binding. */
  resources?: readonly import('../resources/resolve').ResolvedResource[];
  resourceManifestFingerprint?: string;
  /** Test/diagnostic seam: open the fresh page (defaults to the real browser). */
  openPage?: typeof openFreshPage;
  /** Test/diagnostic seam: monotonic clock (defaults to `performance.now`). */
  now?: () => number;
  profile?: ReadinessProfile;
}

export interface ExecutePlanBehavior {
  outcome: Extract<Outcome, 'PASS' | 'BUG' | 'HARNESS_BLOCKED'>;
  requiredChecks: readonly LegacyCompositeCheck[];
  requiredSourcesAgree: boolean;
  harnessInvalid: boolean;
  diagnostics: readonly DiagnosticRecord[];
  resolutions: readonly TargetResolution[];
  targetIds: readonly string[];
  /**
   * Present only when the drive ended at the setup boundary before any behavior
   * phase (ADR 0016 R6). No readiness, capture, Oracle, or native dispatch was
   * entered, so the durable `behaviorOutcome` is honestly `null`.
   */
  preBehaviorRefusal: PreBehaviorSetupRefusal | null;
  seal: {
    constructorId: string;
    constructorVersion: number;
    fixtureId: string;
    activeLayoutId: string;
    documentId: string;
  } | null;
  bridgeContract: {
    version: number | null;
    generation: number | null;
    methods: readonly string[];
    frozen: boolean | null;
    cursorValid: boolean;
    cursorStable: boolean;
    waiterBounded: boolean;
  } | null;
  action: ActionDispatchResult | null;
  actionLogs: readonly StepActionLog[];
  cycle: ActionCycleResult | null;
  observation: CoherentObservation | null;
  oracleInputs: {
    canonicalBefore: { x: number; y: number } | null;
    canonicalAfter: { x: number; y: number } | null;
    renderedBefore: { x: number; y: number } | null;
    renderedAfter: { x: number; y: number } | null;
    baselineGeometry: StampedGeometryView | null;
    observedGeometry: StampedGeometryView | null;
  } | null;
  wakeSource: WakeSource;
  fallbackPollCount: number;
  /** The readiness/Oracle profile identities actually used by this drive. */
  profile: {
    readinessProfileId: string;
    readinessDeadlineMs: number;
    readinessStableFrames: number;
    readinessTimingCategory: string;
    oracleProfileId: string;
  };
  timings: Readonly<Record<string, number | null>>;
  detail: string;
  /** Present only for the Slice 5-C image upload/replace drive. */
  image?: ImageDriveReport | null;
  /** Present only for the three-child generated-Crossword drive. */
  crossword?: CrosswordDriveReport | null;
  /** Present only for the cross-subject history drive. */
  history?: HistoryDriveReport | null;
  /** Present only for the frontend serialize/restore drive. */
  restore?: RestoreDriveReport | null;
}

/**
 * One family projection header without its check set; the Diagnostic
 * orchestration attaches the evaluated checks. These headers are the
 * check-bearing nested projections the current public strict-v4 record
 * requires, and they travel with the final payload exactly as the delivered
 * executor captured them.
 */
export interface ImageProjectionHeader {
  readonly schemaVersion: typeof FINAL_NESTED_PROJECTION_SCHEMA_VERSION;
  readonly family: 'image';
  readonly cycles: readonly Omit<FinalImageCycleProjectionV4, 'checks'>[];
}

export interface CrosswordProjectionHeader {
  readonly schemaVersion: typeof FINAL_NESTED_PROJECTION_SCHEMA_VERSION;
  readonly family: 'crossword';
  readonly providerId: string;
  readonly namespace: string;
  readonly comparisonProfileId: string;
  readonly executions: readonly Omit<FinalCrosswordExecutionProjectionV4, 'checks'>[];
  readonly comparison: FinalCrosswordComparisonV4;
}

export type HistoryProjectionHeader = Omit<FinalHistoryProjectionV4, 'checks'>;
export type RestoreProjectionHeader = Omit<FinalRestoreProjectionV4, 'checks'>;

/**
 * The canonical internal executor-to-final-façade handoff payload (ADR 0033 §1).
 *
 * Every variant carries exactly the sibling B2-B live-fact adapter input minus
 * the envelope/route/Action-Cycle fields the Diagnostic orchestration injects,
 * keyed by the **compiled evaluator discriminant**. The seven variants retain
 * the existing evaluator discriminants and exact field shapes the executors
 * assemble from their own captured primitives.
 *
 * The payload is internal execution data: it is not public evidence, not
 * serialized as a plan, not exported from `src/index.ts`, not accepted from a
 * case request, not recovered from a durable record, and never rebuilt by the
 * CLI. There is exactly one `FinalExecutionPayload` union; the former live payload
 * name is removed and no compatibility alias is retained.
 */
export type FinalExecutionPayload =
  | ({ readonly evaluatorKind: 'geometry-delta'; readonly projection: null } & Omit<
      OrdinaryTextLiveFactAdapterInput,
      'envelope' | 'route' | 'actionCycle'
    >)
  | ({ readonly evaluatorKind: 'warped-text-envelope'; readonly projection: null } & Omit<
      WarpedTextLiveFactAdapterInput,
      'envelope' | 'route' | 'actionCycle'
    >)
  | ({ readonly evaluatorKind: 'nested-object-affine'; readonly projection: null } & Omit<
      NestedObjectLiveFactAdapterInput,
      'envelope' | 'route' | 'actionCycle'
    >)
  | ({
      readonly evaluatorKind: 'image-upload-replace';
      readonly projection: ImageProjectionHeader | null;
    } & Omit<ImageLiveFactAdapterInput, 'envelope' | 'route' | 'actionCycle'>)
  | ({
      readonly evaluatorKind: 'crossword-determinism';
      readonly projection: CrosswordProjectionHeader | null;
    } & Omit<CrosswordLiveFactAdapterInput, 'envelope' | 'route' | 'actionCycle'>)
  | ({
      readonly evaluatorKind: 'history-cross-subject';
      readonly projection: HistoryProjectionHeader | null;
    } & Omit<HistoryLiveFactAdapterInput, 'envelope' | 'route' | 'actionCycle'>)
  | ({
      readonly evaluatorKind: 'frontend-restore';
      readonly projection: RestoreProjectionHeader | null;
    } & Omit<RestoreLiveFactAdapterInput, 'envelope' | 'route' | 'actionCycle'>);

export type FinalExecutionEvaluatorKind = FinalExecutionPayload['evaluatorKind'];

/**
 * One immutable, envelope-bound final observation (ADR 0033 §1). The executor
 * returns it from `ExecutePlanResult.finalObservation`; the Diagnostic
 * orchestration consumes it atomically, and the CLI only forwards it. It
 * carries the exact planning-envelope object by reference, the one Action Cycle
 * identity derived from that envelope, the family payload assembled from the
 * executor's own captured primitives, and the coherent observation id.
 *
 * `null` is allowed only when the executor was never reached or no family
 * execution was entered (a launch failure or a genuine pre-behavior setup
 * refusal). It is never a shorthand for an executor that captured facts but
 * failed a check. One `FinalExecutionObservation` per executor result.
 */
export interface FinalExecutionObservation {
  readonly envelope: MaterializedExecutionEnvelopeV1;
  readonly actionCycle: ActionCycleCorrectnessIdentity;
  readonly payload: FinalExecutionPayload;
  readonly observationId: string | null;
}

export interface ExecutePlanResult {
  behavior: ExecutePlanBehavior;
  browserClose: BrowserCloseOutcome;
  environmentInvalid: boolean;
  /**
   * The exact envelope-bound final observation handoff for this executor run.
   * It is the canonical field the CLI forwards to the final façade; it is
   * `null` only for a launch failure or a genuine pre-behavior setup refusal.
   */
  finalObservation: FinalExecutionObservation | null;
}

/**
 * A distinct pre-behavior terminal: the setup boundary refused before hydration,
 * target resolution, readiness, capture, Oracle, or native dispatch (ADR 0016
 * R6). It is never a fabricated seller-behavior execution.
 */
export interface PreBehaviorSetupRefusal {
  code: string;
  reason: string | null;
  detail: string;
  /** Closed product-side correlation evidence; present for the negative refusal. */
  normalization: SetupNormalizationRefusalEvidence | null;
}

interface BridgeInspection {
  available?: boolean;
  frozen?: unknown;
  methods?: unknown;
  version?: unknown;
  cursorA?: Partial<ObservationCursor> | null;
  cursorB?: Partial<ObservationCursor> | null;
  waiter?: { status?: unknown } | null;
}

/**
 * Exact eight-callable own-method comparison. The inline drive inspection must
 * reject an extra or missing method even when the bridge's own `doctor()`
 * self-report claims otherwise (R15; acceptance test 33).
 */
export function sameBridgeMethodSurface(
  observed: readonly string[],
  expected: readonly string[] = OBSERVATION_BRIDGE_READ_ONLY_METHODS,
): boolean {
  if (observed.length !== expected.length) return false;
  const expectedSet = new Set(expected);
  return observed.every((method) => expectedSet.has(method));
}

const EXECUTE_PLAN_ROUTE = SETUP_ROUTE;

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

/** One complete timestamped pre-dispatch refusal (ADR 0027 §2.3). */
export function refusedActionDispatch(
  detail: string,
  code: DiagnosticCode | undefined,
): ActionDispatchResult {
  return {
    ok: false,
    detail,
    ...(code === undefined ? {} : { code }),
    at: new Date().toISOString(),
  };
}

/** Absolute arithmetic tolerance for the reacquired pre-action dispatch point. */
export const NESTED_PRE_ACTION_HIT_TOLERANCE = 1e-6;

export interface NestedPreActionAuthorityInput {
  targetId: string;
  witnessId: string;
  layoutId: string;
  /** Canonical `layoutItems` of the accepted baseline snapshot. */
  baselineLayoutItems: unknown;
  /** Raw (structurally unknown) baseline `geometryV3` member. */
  baselineGeometryV3: unknown;
  /** Canonical `layoutItems` of the reacquired dispatch snapshot. */
  freshLayoutItems: unknown;
  /** Raw (structurally unknown) reacquired `geometryV3` member. */
  freshGeometryV3: unknown;
  /** The reacquired live hit point, if the bridge published one. */
  freshHitPoint: { x: number; y: number } | undefined;
}

export type NestedPreActionAuthorityResult =
  | { ok: true; point: { x: number; y: number } }
  | { ok: false; detail: string; code: DiagnosticCode };

/**
 * ADR 0014 R8A; ADR 0027 §2.2 pre-dispatch correlation. The accepted baseline
 * record and the reacquired record are each parsed through the closed
 * geometry-v3 contract against a canonical chain derived independently from the
 * matching snapshot before any dereference, so malformed authority refuses
 * before dispatch and is never re-pointed, defaulted, AABB-guessed, or silently
 * reacquired. A parser/contract failure carries the parser's precise geometry
 * diagnostic code; any valid but nonmatching reacquisition carries
 * `HIT_POINT_UNAVAILABLE`.
 */
export function correlateNestedPreActionAuthority(
  input: NestedPreActionAuthorityInput,
): NestedPreActionAuthorityResult {
  const pair = {
    targetId: input.targetId,
    witnessId: input.witnessId,
    layoutId: input.layoutId,
  };
  const baselineDerived = deriveNestedCanonicalChain({
    layoutItems: input.baselineLayoutItems,
    ...pair,
  });
  if (!baselineDerived.ok) {
    return {
      ok: false,
      detail: `Baseline nested canonical chain unavailable at dispatch: ${baselineDerived.failure.detail}`,
      code: baselineDerived.failure.code,
    };
  }
  const baselineParsed = parseNestedGeometryV3({
    raw: input.baselineGeometryV3,
    expected: { ...pair, chain: baselineDerived.derivation.chain },
  });
  if (!baselineParsed.ok) {
    return {
      ok: false,
      detail: `Baseline nested geometry-v3 authority is unusable at dispatch: ${baselineParsed.failure.detail}`,
      code: baselineParsed.failure.code,
    };
  }
  const freshDerived = deriveNestedCanonicalChain({
    layoutItems: input.freshLayoutItems,
    ...pair,
  });
  if (!freshDerived.ok) {
    return {
      ok: false,
      detail: `Reacquired nested canonical chain unavailable at dispatch: ${freshDerived.failure.detail}`,
      code: freshDerived.failure.code,
    };
  }
  const freshParsed = parseNestedGeometryV3({
    raw: input.freshGeometryV3,
    expected: { ...pair, chain: freshDerived.derivation.chain },
  });
  if (!freshParsed.ok) {
    return {
      ok: false,
      detail: `Reacquired nested geometry-v3 authority is unusable at dispatch: ${freshParsed.failure.detail}`,
      code: freshParsed.failure.code,
    };
  }
  const baselineInteraction = baselineParsed.geometry.interaction;
  const freshInteraction = freshParsed.geometry.interaction;
  if (baselineInteraction.phase !== 'pre-action' || freshInteraction.phase !== 'pre-action') {
    return {
      ok: false,
      detail: 'The nested pre-action typed authority is unavailable at dispatch.',
      code: 'HIT_POINT_UNAVAILABLE',
    };
  }
  // The parser proves a finite point, `authority: action`, `status: authorized`,
  // and both non-empty fingerprints for a pre-action member.
  if (
    freshParsed.geometry.recordFingerprint !== baselineParsed.geometry.recordFingerprint ||
    freshInteraction.interactionFingerprint !== baselineInteraction.interactionFingerprint
  ) {
    return {
      ok: false,
      detail:
        'The reacquired pre-action record does not match the accepted baseline record fingerprint and interaction fingerprint.',
      code: 'HIT_POINT_UNAVAILABLE',
    };
  }
  const baselinePoint = baselineInteraction.point;
  if (
    input.freshHitPoint === undefined ||
    Math.abs(input.freshHitPoint.x - baselinePoint.x) > NESTED_PRE_ACTION_HIT_TOLERANCE ||
    Math.abs(input.freshHitPoint.y - baselinePoint.y) > NESTED_PRE_ACTION_HIT_TOLERANCE
  ) {
    return {
      ok: false,
      detail:
        'The reacquired dispatch point does not match the accepted baseline interaction point.',
      code: 'HIT_POINT_UNAVAILABLE',
    };
  }
  return { ok: true, point: { x: baselinePoint.x, y: baselinePoint.y } };
}

/**
 * Projects the observed Action Cycle timings onto the public
 * `Record<string, number | null>` contract explicitly. The domain type keeps its
 * exact named fields and gains no index signature.
 */
function projectCycleTimings(
  timings: ActionCycleTimings | undefined,
): Readonly<Record<string, number | null>> {
  if (timings === undefined) return {};
  return {
    armedAtMs: timings.armedAtMs,
    actionCompletedAtMs: timings.actionCompletedAtMs,
    transitionAtMs: timings.transitionAtMs,
    quiescentAtMs: timings.quiescentAtMs,
    capturedAtMs: timings.capturedAtMs,
    deadlineAtMs: timings.deadlineAtMs,
    totalMs: timings.totalMs,
  };
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

function isWellFormedCursor(value: unknown): value is ObservationCursor {
  if (value === null || typeof value !== 'object') return false;
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

function finalEvidenceFacts(
  evidenceIds: readonly string[],
  authority: 'current' | 'malformed',
): readonly { evidenceId: string; availability: 'authoritative' | 'malformed' }[] {
  const availability = authority === 'current' ? 'authoritative' : 'malformed';
  return evidenceIds.map((evidenceId) => ({ evidenceId, availability }));
}

/**
 * Builds the generic final observation while the Action Cycle still owns the
 * accepted Oracle primitives. Specialized families deliberately return through
 * their own result slices until their family handoffs are migrated.
 */
function buildGenericFinalObservation(input: {
  readonly envelope: MaterializedExecutionEnvelopeV1;
  readonly allocation: RunAllocation;
  readonly caseId: string;
  readonly intent: CaseIntent;
  readonly cycle: ActionCycleResult;
}): FinalExecutionObservation | null {
  const oracleKind = input.envelope.correctnessProfile.oracle.evaluatorKind;
  const primitiveFacts = input.cycle.primitiveFacts;
  const evidence = finalEvidenceFacts(
    input.envelope.correctnessProfile.requiredAuthoritativeEvidence,
    primitiveFacts.authority,
  );
  const minimumDelta = readMinimumDelta(input.intent.expected);
  const observationId = input.cycle.observation?.observationId ?? null;
  let payload: FinalExecutionPayload;

  switch (oracleKind) {
    case 'geometry-delta': {
      const geometry = input.cycle.oracle?.geometry ?? null;
      payload = {
        evaluatorKind: 'geometry-delta',
        projection: null,
        minimumDelta,
        delta:
          geometry === null
            ? null
            : {
                checkId: geometry.checkId,
                canonicalDelta: geometry.canonicalDelta,
                renderedDelta: geometry.renderedDelta,
                agreement: geometry.agreement,
                canonicalMet: geometry.canonicalMet,
                renderedMet: geometry.renderedMet,
                sourcesAgree: geometry.sourcesAgree,
                detail: geometry.detail,
              },
        evidence,
      };
      break;
    }
    case 'warped-text-envelope': {
      const warped = input.cycle.oracle?.warped ?? null;
      payload = {
        evaluatorKind: 'warped-text-envelope',
        projection: null,
        minimumDelta,
        oracle:
          warped === null
            ? null
            : {
                profileId: warped.profileId,
                primitiveFacts: {
                  authority: warped.primitiveFacts.authority,
                  canonicalSourcesAgree: warped.primitiveFacts.canonicalSourcesAgree,
                  rendererSourcesAgree: warped.primitiveFacts.rendererSourcesAgree,
                  checks: warped.primitiveFacts.checks.map((check) => ({
                    checkId: check.checkId,
                    predicateMet: check.predicateMet,
                  })),
                },
                delta: warped.delta,
                envelope: warped.envelope,
              },
        evidence,
      };
      break;
    }
    case 'nested-object-affine': {
      const oracle = input.cycle.oracle;
      payload = {
        evaluatorKind: 'nested-object-affine',
        projection: null,
        minimumDelta,
        oracle:
          oracle === null
            ? null
            : {
                primitiveFacts: {
                  authority: oracle.primitiveFacts.authority,
                  sourcesAgree: oracle.primitiveFacts.sourcesAgree,
                  checks: oracle.primitiveFacts.checks.map((check) => ({
                    checkId: check.checkId,
                    predicateMet: check.predicateMet,
                  })),
                },
                facts: oracle.nested,
              },
        evidence,
      };
      break;
    }
    default:
      return null;
  }

  const actionCycleId = `final:${input.allocation.runId}:${input.caseId}:${payload.evaluatorKind}`;
  const immutablePayload = Object.freeze(payload);
  return Object.freeze({
    envelope: input.envelope,
    actionCycle: bindFinalActionCycleIdentity({
      envelope: input.envelope,
      actionCycleId,
    }),
    payload: immutablePayload,
    observationId,
  });
}

export async function executePlan(input: ExecutePlanInput): Promise<ExecutePlanResult> {
  // A workflow that declares exactly the closed six-transition history shape is
  // driven by the cross-subject history drive. The discriminant is the resolved
  // declarative workflow shape, never a Subject/scenario/variant branch.
  if (historyWorkflowMatches(input.workflowSteps)) {
    const result = await executeHistoryPlan({
      allocation: input.allocation,
      caseId: input.caseId,
      intent: input.intent,
      plan: input.plan,
      adapter: input.adapter,
      fixture: input.fixture,
      workflowSteps: input.workflowSteps,
      environment: input.environment,
      meaningProvider: input.meaningProvider,
      envelope: input.envelope,
      ...(input.openPage === undefined ? {} : { openPage: input.openPage }),
      ...(input.now === undefined ? {} : { now: input.now }),
    });
    return {
      behavior: { ...result.behavior, history: result.history },
      browserClose: result.browserClose,
      environmentInvalid: result.environmentInvalid,
      finalObservation: result.finalObservation,
    };
  }

  // A workflow that declares exactly the closed frontend serialize/restore shape
  // (the seller Save activation plus the closed runtime handoff) is driven by the
  // frontend restore drive. The discriminant is the resolved declarative workflow
  // shape, never a Subject/scenario/variant branch.
  if (restoreWorkflowMatches(input.workflowSteps)) {
    const result = await executeRestorePlan({
      allocation: input.allocation,
      caseId: input.caseId,
      intent: input.intent,
      plan: input.plan,
      adapter: input.adapter,
      fixture: input.fixture,
      workflowSteps: input.workflowSteps,
      environment: input.environment,
      meaningProvider: input.meaningProvider,
      envelope: input.envelope,
      ...(input.openPage === undefined ? {} : { openPage: input.openPage }),
      ...(input.now === undefined ? {} : { now: input.now }),
    });
    return {
      behavior: { ...result.behavior, restore: result.restore },
      browserClose: result.browserClose,
      environmentInvalid: result.environmentInvalid,
      finalObservation: result.finalObservation,
    };
  }

  if (input.workflowSteps.some((step) => step.primitive === 'fileInput.set')) {
    const result = await executeImagePlan({
      allocation: input.allocation,
      caseId: input.caseId,
      intent: input.intent,
      plan: input.plan,
      adapter: input.adapter,
      fixture: input.fixture,
      workflowSteps: input.workflowSteps,
      environment: input.environment,
      envelope: input.envelope,
      resources: input.resources ?? [],
      resourceManifestFingerprint: input.resourceManifestFingerprint ?? '',
      ...(input.openPage === undefined ? {} : { openPage: input.openPage }),
      ...(input.now === undefined ? {} : { now: input.now }),
    });
    return { ...result, behavior: { ...result.behavior, image: result.image } };
  }

  // A create capability whose fixture declares a `post-action-new` role is
  // driven by the sequential three-child generated drive. The discriminant is
  // the closed role-timing field, never a Subject/scenario/word literal.
  if (fixtureRequiresSequentialChildren(input.fixture)) {
    const result = await executeCrosswordPlan({
      allocation: input.allocation,
      caseId: input.caseId,
      intent: input.intent,
      plan: input.plan,
      adapter: input.adapter,
      fixture: input.fixture,
      workflowSteps: input.workflowSteps,
      environment: input.environment,
      envelope: input.envelope,
      ...(input.openPage === undefined ? {} : { openPage: input.openPage }),
      ...(input.now === undefined ? {} : { now: input.now }),
    });
    return result;
  }

  const now = input.now ?? (() => performance.now());
  const profile = input.profile ?? ACTION_CYCLE_V1_PROFILE;
  let activeProfileUsed: ReadinessProfile = profile;
  let oracleProfileUsed = 'geometry-delta-v1';
  const diagnostics: DiagnosticRecord[] = [];
  const resolutions: TargetResolution[] = [];
  const targetIds: string[] = [];
  let bridgeContract: ExecutePlanBehavior['bridgeContract'] = null;
  let seal: ExecutePlanBehavior['seal'] = null;
  let action: ActionDispatchResult | null = null;
  let actionLogs: readonly StepActionLog[] = [];
  let cycle: ActionCycleResult | null = null;
  let oracleInputs: ExecutePlanBehavior['oracleInputs'] = null;
  let session: BrowserSession | null = null;
  let browserClose: BrowserCloseOutcome = { closed: true, detail: null };
  let environmentInvalid = false;
  let harnessInvalid = false;
  let outcome: Extract<Outcome, 'PASS' | 'BUG' | 'HARNESS_BLOCKED'> = 'HARNESS_BLOCKED';
  let requiredChecks: readonly LegacyCompositeCheck[] = input.plan.requiredChecks.map(
    (checkId) => ({
      checkId,
      passed: false,
    }),
  );
  let requiredSourcesAgree = true;
  let detail = 'Diagnostic drive did not complete.';
  let preBehaviorRefusal: PreBehaviorSetupRefusal | null = null;
  let finalObservation: FinalExecutionObservation | null = null;

  const finish = (): ExecutePlanResult => ({
    behavior: {
      outcome,
      requiredChecks,
      requiredSourcesAgree,
      harnessInvalid,
      diagnostics,
      resolutions,
      targetIds,
      preBehaviorRefusal,
      seal,
      bridgeContract,
      action,
      actionLogs,
      cycle,
      observation: cycle?.observation ?? null,
      oracleInputs,
      wakeSource: cycle?.wakeSource ?? 'none',
      fallbackPollCount: cycle?.fallbackPollCount ?? 0,
      profile: {
        readinessProfileId: activeProfileUsed.profileId,
        readinessDeadlineMs: activeProfileUsed.deadlineMs,
        readinessStableFrames: activeProfileUsed.stableFrames,
        readinessTimingCategory: activeProfileUsed.timingCategory,
        oracleProfileId: oracleProfileUsed,
      },
      timings: projectCycleTimings(cycle?.timings),
      detail,
    },
    browserClose,
    environmentInvalid,
    finalObservation,
  });

  try {
    session = await (input.openPage ?? openFreshPage)({
      baseUrl: input.allocation.baseUrl,
      route: EXECUTE_PLAN_ROUTE,
      environment: input.environment,
      navigationTimeoutMs: 60_000,
    });
    const { page } = session;

    await page.waitForFunction(
      (name) => Boolean((window as unknown as Record<string, unknown>)[name]),
      OBSERVATION_GLOBAL_NAME,
      { timeout: 30_000 },
    );

    // ── Precondition: Doctor v4 bridge-contract inspection (inline) ─────────
    const inspection = (await page.evaluate(
      buildDoctorBridgeInspectionScript(),
    )) as BridgeInspection;
    const observedMethods = asStringArray(inspection.methods);
    const methodsExact = sameBridgeMethodSurface(observedMethods);
    const cursorA = isWellFormedCursor(inspection.cursorA) ? inspection.cursorA : null;
    const cursorB = isWellFormedCursor(inspection.cursorB) ? inspection.cursorB : null;
    bridgeContract = {
      version: asNumber(inspection.version),
      generation: cursorA?.bridgeGeneration ?? null,
      methods: observedMethods,
      frozen: inspection.frozen === true ? true : inspection.frozen === false ? false : null,
      cursorValid: cursorA !== null,
      cursorStable:
        cursorA !== null &&
        cursorB !== null &&
        cursorA.revision === cursorB.revision &&
        cursorA.bridgeGeneration === cursorB.bridgeGeneration,
      waiterBounded: inspection.waiter?.status === 'timeout',
    };
    // Precise, distinct bridge-surface failures: a wrong version, method drift,
    // an unfrozen object, an invalid/unstable cursor, and an unbounded waiter are
    // never collapsed into a single `BRIDGE_VERSION_MISMATCH` (R14, R15).
    const bridgePreconditions: Array<{ code: DiagnosticCode; detail: string }> = [];
    if (inspection.available !== true) {
      bridgePreconditions.push({
        code: 'BRIDGE_UNAVAILABLE',
        detail: 'The observation bridge was not available for inline inspection.',
      });
    } else {
      if (bridgeContract.version !== OBSERVATION_BRIDGE_VERSION) {
        bridgePreconditions.push({
          code: 'BRIDGE_VERSION_MISMATCH',
          detail: `Observation bridge version ${String(bridgeContract.version)} does not match required v${OBSERVATION_BRIDGE_VERSION}.`,
        });
      }
      if (!methodsExact) {
        bridgePreconditions.push({
          code: 'BRIDGE_SURFACE_MISMATCH',
          detail: `Observation bridge exposes ${observedMethods.join(', ') || 'no callable methods'}, not the exact ${OBSERVATION_BRIDGE_READ_ONLY_METHODS.length}-method read-only surface.`,
        });
      }
      if (bridgeContract.frozen !== true) {
        bridgePreconditions.push({
          code: 'BRIDGE_NOT_FROZEN',
          detail: 'Observation bridge object is not frozen.',
        });
      }
      if (!bridgeContract.cursorValid) {
        bridgePreconditions.push({
          code: 'BRIDGE_CURSOR_INVALID',
          detail: 'The observation cursor could not be read as a well-formed v4 cursor.',
        });
      } else if (!bridgeContract.cursorStable) {
        bridgePreconditions.push({
          code: 'BRIDGE_CURSOR_INVALID',
          detail: 'Two consecutive observation cursor reads did not agree on generation/revision.',
        });
      }
      if (!bridgeContract.waiterBounded) {
        bridgePreconditions.push({
          code: 'BRIDGE_WAITER_UNBOUNDED',
          detail: `The bounded zero-timeout waiter did not report a timeout (status=${String(inspection.waiter?.status)}).`,
        });
      }
    }
    if (bridgePreconditions.length > 0) {
      harnessInvalid = true;
      for (const precondition of bridgePreconditions) {
        diagnostics.push(createDiagnostic(precondition.code, precondition.detail));
      }
      detail = `Observation bridge v${OBSERVATION_BRIDGE_VERSION} precondition failed before setup: ${bridgePreconditions.map((entry) => entry.code).join(', ')}.`;
      return finish();
    }

    // ── Seal the existing two-layout Text constructor ───────────────────────
    await page.waitForFunction(
      (name) => Boolean((window as unknown as Record<string, unknown>)[name]),
      SETUP_GLOBAL_NAME,
      { timeout: 30_000 },
    );
    const setupStatus = await readSetupStatus(page);
    if (setupStatus === null) {
      harnessInvalid = true;
      diagnostics.push(
        createDiagnostic('SEAL_NOT_CONFIRMED', 'The setup boundary exposed no status projection.'),
      );
      detail = 'Setup boundary status was unavailable.';
      return finish();
    }
    const authorization = createSetupAuthorization({
      runId: input.allocation.runId,
      caseId: input.caseId,
      origin: new URL(input.allocation.baseUrl).origin,
      documentId: setupStatus.document.documentId,
    });
    await deliverSetupAuthorization(page, authorization);
    const constructOutcome = await invokeSetupConstructor(page, {
      constructorId: input.fixture.constructorId,
      constructorVersion: input.fixture.constructorVersion,
      scope: { runId: input.allocation.runId, caseId: input.caseId },
      inputs: structuredClone(input.fixture.inputs) as Record<string, unknown>,
    });
    const refusal = sealFailure(constructOutcome);
    if (refusal !== null) {
      harnessInvalid = true;
      const code =
        !constructOutcome.ok && constructOutcome.code !== null
          ? constructOutcome.code
          : 'SEAL_NOT_CONFIRMED';
      const reason = !constructOutcome.ok ? (constructOutcome.context.reason ?? null) : null;
      preBehaviorRefusal = {
        code,
        reason,
        detail:
          reason === null
            ? `Setup did not seal: ${refusal}`
            : `Setup did not seal: ${code} (${reason})`,
        normalization:
          !constructOutcome.ok && constructOutcome.outcome === 'refused'
            ? (constructOutcome.normalizationRefusal ?? null)
            : null,
      };
      diagnostics.push(
        createDiagnostic(code, refusal, { context: { runId: input.allocation.runId } }),
      );
      detail = preBehaviorRefusal.detail;
      return finish();
    }
    if (!constructOutcome.ok) {
      harnessInvalid = true;
      diagnostics.push(
        createDiagnostic('SEAL_NOT_CONFIRMED', 'Setup did not return a seal record.'),
      );
      detail = 'Setup did not seal.';
      return finish();
    }
    const sealRecord: SetupSealRecord = constructOutcome.sealRecord;
    seal = {
      constructorId: sealRecord.constructor.id,
      constructorVersion: sealRecord.constructor.version,
      fixtureId: sealRecord.constructor.fixtureId,
      activeLayoutId: sealRecord.semanticPrecondition.activeLayoutId,
      documentId: sealRecord.document.documentId,
    };

    // ── Resolve exactly one active-layout Text target (before any action) ───
    const elements = (await page.evaluate(bridgeCallScript('return bridge.elements();'))) as
      | DiagnosticBridgeElements
      | { __bridgeMissing: true };
    if ('__bridgeMissing' in elements) {
      harnessInvalid = true;
      diagnostics.push(
        createDiagnostic('BRIDGE_UNAVAILABLE', 'Observation bridge disappeared after the seal.'),
      );
      detail = 'Observation bridge unavailable after seal.';
      return finish();
    }
    resolutions.push(
      ...input.adapter.resolveTargets({
        phase: 'pre-action',
        roles: input.fixture.semanticTargetRoles,
        elements: elements.elements,
        activeLayoutId: seal.activeLayoutId,
      }),
    );
    for (const resolution of resolutions) {
      const finding = targetResolutionDiagnostic(resolution, { subjectId: input.intent.subjectId });
      if (finding) diagnostics.push(finding);
      if (resolution.status === 'resolved' && resolution.target) {
        targetIds.push(resolution.target.elementId);
      }
    }
    if (targetIds.length === 0 || resolutions.some((entry) => entry.status !== 'resolved')) {
      harnessInvalid = true;
      detail = `Target resolution blocked before action: ${resolutions
        .map((entry) => `${entry.role}=${entry.status}(${entry.matchCount})`)
        .join(', ')}.`;
      return finish();
    }

    // The adapter owns the profile and the required checks this binding needs;
    // the engine selects nothing by Subject, scenario, or variant itself.
    const normalized = input.adapter.normalizeResult(
      resolutions,
      input.intent.capability,
      input.plan.requiredChecks,
    );
    const effectiveRequiredChecks = normalized.requiredChecks;
    requiredChecks = effectiveRequiredChecks.map((checkId) => ({ checkId, passed: false }));
    const readiness = input.adapter.contributeReadiness({
      phase: 'pre-action',
      roles: input.fixture.semanticTargetRoles,
      resolutions,
    });
    // The adapter contributes the readiness profile id; the registry (never a
    // Subject/scenario branch) resolves the timing policy, capture recipe, and
    // Oracle profile.
    const registration = resolveReadinessProfile(readiness.profileId);
    if (registration === null) {
      harnessInvalid = true;
      diagnostics.push(
        createDiagnostic(
          'READINESS_DEADLINE_EXCEEDED',
          `Adapter contributed unknown readiness profile "${readiness.profileId}".`,
        ),
      );
      detail = `Unknown readiness profile "${readiness.profileId}".`;
      return finish();
    }
    const warpedExpectedLayoutId =
      registration.oracleProfileId === 'warped-text-circle-move-v1' ? seal.activeLayoutId : null;
    const activeProfile = registration.profile;
    activeProfileUsed = activeProfile;
    oracleProfileUsed = registration.oracleProfileId;
    const nestedPair = registration.requiresNestedPair
      ? {
          targetId: targetIds[0] as string,
          witnessId: targetIds[1] as string,
          layoutId: seal.activeLayoutId,
        }
      : null;
    const nestedRequestedPointerDelta =
      nestedPair === null
        ? null
        : {
            x: Number(input.intent.operations[0]?.parameters.dx ?? Number.NaN),
            y: Number(input.intent.operations[0]?.parameters.dy ?? Number.NaN),
          };
    const readGenericGeometry = async (id: string): Promise<StampedGeometryView> =>
      (await page.evaluate(
        bridgeCallScript(`return bridge.geometry(${JSON.stringify(id)});`),
      )) as StampedGeometryView;
    /**
     * One phase-explicit nested read (ADR 0014 R4/R13). The baseline, the
     * precondition and the dispatch reacquisition all use the pre-action
     * authorize-native-action request; only the post-action coherent capture
     * uses the observe-authoritative-geometry request. The phase is never
     * inferred from selection, chrome, revision, or call timing.
     */
    const readNestedGeometryWith = async (
      phase: 'pre-action' | 'post-action',
    ): Promise<StampedGeometryView> => {
      if (nestedPair === null) return readGenericGeometry(targetIds[0] as string);
      const request = {
        schemaVersion: 1,
        representation: NESTED_OBJECT_AFFINE_CHAIN_KIND,
        targetId: nestedPair.targetId,
        witnessId: nestedPair.witnessId,
        layoutId: nestedPair.layoutId,
        interaction:
          phase === 'pre-action'
            ? { phase: 'pre-action', purpose: 'authorize-native-action' }
            : { phase: 'post-action', purpose: 'observe-authoritative-geometry' },
      };
      return (await page.evaluate(
        bridgeCallScript(`return bridge.geometry(${JSON.stringify(request)});`),
      )) as StampedGeometryView;
    };
    const readTargetGeometryPre = () => readNestedGeometryWith('pre-action');
    const readTargetGeometryPost = () => readNestedGeometryWith('post-action');

    // ── Pre-action hit point + precondition quiescence + baseline ───────────
    const targetId = targetIds[0] as string;
    const preGeometry = await readTargetGeometryPre();
    const preSnapshot = (await page.evaluate(
      bridgeCallScript('return bridge.snapshot();'),
    )) as DiagnosticBridgeSnapshot;
    const preProblems = input.adapter.validatePreconditions({
      resolutions,
      geometry: {
        [targetId]: {
          elementId: preGeometry.id,
          mounted: preGeometry.mounted,
          visible: preGeometry.visible === true,
          listening: preGeometry.listening === true,
          hasHitPoint: preGeometry.hitPoint !== undefined,
        },
      },
      typedGeometry: { [targetId]: preGeometry },
      canonical: {
        layoutItems: preSnapshot.layoutItems,
        expectedLayoutId: seal.activeLayoutId,
      },
    });
    if (preProblems.length > 0) {
      harnessInvalid = true;
      for (const problem of preProblems) {
        diagnostics.push(
          createDiagnostic(problem.code, problem.detail, { context: problem.context }),
        );
      }
      detail = `Target precondition failed: ${preProblems.map((entry) => entry.code).join(', ')}.`;
      return finish();
    }

    await page.evaluate(
      bridgeAsyncScript(
        `return await bridge.waitForIdle({ targets: ${JSON.stringify(
          nestedPair === null ? targetIds : [nestedPair.targetId, nestedPair.witnessId],
        )}, stableFrames: ${activeProfile.stableFrames}, timeoutMs: ${activeProfile.deadlineMs}${
          nestedPair === null ? '' : `, nested: ${JSON.stringify(nestedPair)}`
        } });`,
      ),
    );

    const baselineCursor = (await page.evaluate(
      bridgeCallScript('return bridge.cursor();'),
    )) as ObservationCursor;
    const baselineSnapshot = (await page.evaluate(
      bridgeCallScript('return bridge.snapshot();'),
    )) as DiagnosticBridgeSnapshot;
    const baselineGeometry = await readTargetGeometryPre();

    if (!isWellFormedCursor(baselineCursor)) {
      harnessInvalid = true;
      diagnostics.push(
        createDiagnostic('UNUSABLE_EVIDENCE', 'Baseline observation cursor was malformed.'),
      );
      detail = 'Baseline cursor malformed.';
      return finish();
    }

    const minimumDelta = readMinimumDelta(input.intent.expected);
    const baselinePosition = findCanonicalPosition(baselineSnapshot.layoutItems, targetId);
    const baselineRevision = baselineCursor.revision;

    const performAction = async (): Promise<ActionDispatchResult> => {
      const fresh = await readTargetGeometryPre();
      let dispatchPoint = fresh.hitPoint ?? { x: Number.NaN, y: Number.NaN };
      if (nestedPair !== null) {
        const freshSnapshot = (await page.evaluate(
          bridgeCallScript('return bridge.snapshot();'),
        )) as DiagnosticBridgeSnapshot;
        const correlation = correlateNestedPreActionAuthority({
          targetId: nestedPair.targetId,
          witnessId: nestedPair.witnessId,
          layoutId: nestedPair.layoutId,
          baselineLayoutItems: baselineSnapshot.layoutItems,
          baselineGeometryV3: baselineGeometry.geometryV3,
          freshLayoutItems: freshSnapshot.layoutItems,
          freshGeometryV3: fresh.geometryV3,
          freshHitPoint: fresh.hitPoint,
        });
        if (!correlation.ok) {
          // One complete timestamped refusal; the native dispatch count stays
          // zero and the drive classifies the refusal as `HARNESS_BLOCKED`.
          action = refusedActionDispatch(correlation.detail, correlation.code);
          return action;
        }
        dispatchPoint = correlation.point;
      }
      const stepResult = await executeWorkflowSteps({
        steps: input.workflowSteps,
        operation: input.intent.operations[0],
        resolutions,
        points: { [targetId]: dispatchPoint },
        handlers: {
          pointerDrag: async (request) => {
            const dispatch = await pointerDrag({
              page,
              target: { hitPoint: dispatchPoint, viewportRect: fresh.viewportRect },
              dx: request.dx,
              dy: request.dy,
            });
            if (!dispatch.ok) {
              action = {
                ok: false,
                detail: dispatch.detail,
                code: dispatch.code,
                at: new Date().toISOString(),
              };
              return { ok: false, detail: dispatch.detail, code: dispatch.code };
            }
            action = {
              ok: true,
              detail: `Native pointer drag from (${dispatch.log.from.x}, ${dispatch.log.from.y}) by (${request.dx}, ${request.dy}).`,
              at: dispatch.log.startedAt,
            };
            return { ok: true, detail: action.detail };
          },
          pointerClick: async () => ({
            ok: false,
            detail: 'pointer.click is not delivered for this binding.',
          }),
          controlActivate: async () => ({
            ok: false,
            detail: 'control.activate is not delivered for this binding.',
          }),
          keyboardPress: async () => ({
            ok: false,
            detail: 'keyboard.press is not delivered for this binding.',
          }),
          fileInputSet: async () => ({
            ok: false,
            detail: 'fileInput.set is not delivered for this binding.',
          }),
        },
      });
      actionLogs = stepResult.logs;
      if (!stepResult.ok) {
        // A structural workflow failure keeps its workflow code; a primitive
        // refusal keeps its precise primitive code (e.g. HIT_POINT_UNAVAILABLE).
        // No failure is blanket-converted to HIT_POINT_UNAVAILABLE (R14).
        return {
          ok: false,
          detail: stepResult.finding.detail,
          code: stepResult.finding.code,
          at: new Date().toISOString(),
        };
      }
      return (
        action ?? { ok: true, detail: 'Native action dispatched.', at: new Date().toISOString() }
      );
    };

    const evaluateCausalTransition = async (): Promise<CausalPredicateResult> => {
      const snapshot = (await page.evaluate(
        bridgeCallScript('return bridge.snapshot();'),
      )) as DiagnosticBridgeSnapshot;
      const position = findCanonicalPosition(snapshot.layoutItems, targetId);
      const revisionAdvanced = snapshot.observation.revision > baselineRevision;
      const moved =
        baselinePosition !== null &&
        position !== null &&
        (Math.abs(position.x - baselinePosition.x) > 1e-6 ||
          Math.abs(position.y - baselinePosition.y) > 1e-6);
      return {
        satisfied: revisionAdvanced && moved,
        detail:
          position === null
            ? `Target "${targetId}" canonical position is unavailable.`
            : `Canonical position (${position.x}, ${position.y}) vs baseline (${baselinePosition?.x ?? 'n/a'}, ${baselinePosition?.y ?? 'n/a'}); revision ${snapshot.observation.revision} vs ${baselineRevision}.`,
      };
    };

    cycle = await runActionCycle({
      profile: activeProfile,
      now,
      targetIds,
      requiredChecks: effectiveRequiredChecks,
      minimumDelta,
      warpedExpectedLayoutId,
      nestedTarget:
        nestedPair === null || nestedRequestedPointerDelta === null
          ? null
          : {
              targetId: nestedPair.targetId,
              witnessId: nestedPair.witnessId,
              layoutId: nestedPair.layoutId,
              requestedPointerDeltaCss: nestedRequestedPointerDelta,
            },
      baseline: {
        cursor: baselineCursor,
        snapshot: baselineSnapshot,
        geometry: { [targetId]: baselineGeometry },
      },
      readCursor: async () =>
        (await page.evaluate(bridgeCallScript('return bridge.cursor();'))) as ObservationCursor,
      readSnapshot: async () =>
        (await page.evaluate(
          bridgeCallScript('return bridge.snapshot();'),
        )) as DiagnosticBridgeSnapshot,
      readGeometry: async (_id) =>
        nestedPair === null ? readGenericGeometry(_id) : readTargetGeometryPost(),
      waitForChange: async (after, timeoutMs) =>
        (await page.evaluate(
          bridgeAsyncScript(
            `return await bridge.waitForChange({ after: ${JSON.stringify(after)}, timeoutMs: ${timeoutMs} });`,
          ),
        )) as WaitForChangeOutcome,
      waitForIdle: async (options) =>
        (await page.evaluate(
          bridgeAsyncScript(`return await bridge.waitForIdle(${JSON.stringify(options)});`),
        )) as {
          observation: ObservationCursor;
          snapshot: StampedSnapshotView;
          renderer: {
            bridgeGeneration: number;
            stageFingerprint: string;
            targets: readonly {
              id: string;
              fingerprint: string;
              mounted: boolean;
              visible: boolean;
              listening: boolean;
            }[];
          };
        },
      evaluateCausalTransition,
      performAction,
    });

    requiredChecks = cycle.requiredChecks;
    requiredSourcesAgree = cycle.requiredSourcesAgree;
    harnessInvalid = cycle.harnessInvalid;
    outcome = cycle.behaviorOutcome;
    diagnostics.push(...cycle.diagnostics);
    detail = cycle.detail;

    if (cycle.observation !== null) {
      const observedGeometry = cycle.observation.geometry[targetId];
      oracleInputs = {
        canonicalBefore: findCanonicalPosition(baselineSnapshot.layoutItems, targetId),
        canonicalAfter: findCanonicalPosition(cycle.observation.snapshot.layoutItems, targetId),
        renderedBefore: renderedTransformPosition(baselineGeometry, targetId),
        renderedAfter: renderedTransformPosition(observedGeometry, targetId),
        baselineGeometry,
        observedGeometry: observedGeometry ?? null,
      };
    }
    finalObservation = buildGenericFinalObservation({
      envelope: input.envelope,
      allocation: input.allocation,
      caseId: input.caseId,
      intent: input.intent,
      cycle,
    });
  } catch (error) {
    environmentInvalid = true;
    diagnostics.push(
      createDiagnostic(
        'RUNTIME_LAUNCH_FAILED',
        `Diagnostic drive runtime failed: ${(error as Error).message}`,
      ),
    );
    detail = `Diagnostic drive runtime failed: ${(error as Error).message}`;
  } finally {
    if (session) {
      browserClose = await closeBrowserSession(session);
      if (!browserClose.closed) {
        environmentInvalid = true;
        diagnostics.push(
          createDiagnostic(
            'BROWSER_CLEANUP_FAILED',
            `Owned browser could not be closed: ${browserClose.detail ?? 'unknown'}.`,
          ),
        );
      }
    }
    // A runtime/environment failure must recompute the behaviour outcome without
    // ever presenting itself as a product `BUG`.
    if (environmentInvalid) {
      harnessInvalid = true;
      outcome = classifyOutcome({
        requiredChecks,
        cleanupSucceeded: true,
        harnessInvalid: true,
        environmentInvalid: true,
      }) as Extract<Outcome, 'PASS' | 'BUG' | 'HARNESS_BLOCKED'>;
    }
  }

  return finish();
}

export const EXECUTE_PLAN_EVIDENCE_FILES = {
  runRecord: path.join('run-record.json'),
} as const;
