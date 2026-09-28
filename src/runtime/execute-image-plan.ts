import type { Page } from '@playwright/test';

import type { SubjectAdapter, TargetResolution } from '../contracts/adapter';
import { targetResolutionDiagnostic } from '../contracts/adapter';
import type { CaseIntent, ExecutionPlan } from '../contracts/case-model';
import {
  createDiagnostic,
  type DiagnosticCode,
  type DiagnosticRecord,
} from '../contracts/diagnostics';
import type { Outcome } from '../contracts/discriminants';
import { FINAL_NESTED_PROJECTION_SCHEMA_VERSION } from '../contracts/final-record-v4';
/**
 * Private/deprecated legacy composite check mirror (ADR 0032 §E3-S1). It is
 * retained only so this active runtime executor producer compiles until the
 * E3-S2 architecture switch consumes the additive `primitiveFacts` the Image
 * Oracle exposes through `ImageOracleEvaluation`. It is deliberately declared
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
import type { ObservationCursor, WaitForChangeOutcome, WakeSource } from '../contracts/observation';
import type { ResourceProbe } from '../contracts/resources';
import type { EnvironmentCell, RunAllocation } from '../contracts/runtime';
import {
  OBSERVATION_BRIDGE_READ_ONLY_METHODS,
  OBSERVATION_BRIDGE_VERSION,
  OBSERVATION_GLOBAL_NAME,
  SETUP_GLOBAL_NAME,
  SETUP_ROUTE,
} from '../contracts/seam';
import type { SetupSealRecord } from '../contracts/seam';
import type { WorkflowStep } from '../contracts/workflows';
import {
  findCanonicalImageLayer,
  IMAGE_CONTENT_DISTINCT_CHECK,
  IMAGE_REPLACE_CONTROL_READY_CHECK,
} from '../adapters/image-specialized';
import {
  buildDoctorBridgeInspectionScript,
  closeBrowserSession,
  type BrowserCloseOutcome,
} from '../browser/doctor';
import { openFreshPage, type BrowserSession } from '../browser/launch';
import { activateControl, pointerClick, setFileInput } from '../browser/primitives';
import {
  createSetupAuthorization,
  deliverSetupAuthorization,
  invokeSetupConstructor,
  readSetupStatus,
  type SetupConstructorOutcome,
} from '../browser/seam';
import {
  evaluateImageOracle,
  type ImageCheckResult,
  type ImageOracleInput,
} from '../oracles/image';
import type { MaterializedExecutionEnvelopeV1 } from '../planner/execution-materialization';
import { IMAGE_RASTER_ACTION_CYCLE_PROFILE } from '../readiness/correlated-gate';
import {
  captureCoherentObservation,
  type CoherentObservation,
  type RasterBracketView,
  type StampedGeometryView,
  type TornObservation,
} from '../readiness/coherent-capture';
import {
  awaitExpectedRasterConvergence,
  evaluateExpectedRasterCurrentness,
  type AcceptedRasterUpload,
  type ExpectedRasterResource,
} from '../readiness/raster-currentness';
import type { CausalPredicateResult } from '../readiness/correlated-gate';
import { awaitCausalTransition, type CorrelatedGateResult } from '../readiness/correlated-gate';
import { findResolvedResource, type ResolvedResource } from '../resources/resolve';
import type { InstalledResourceRoutes } from '../resources/routes';
import { registerResourceRoutes } from '../resources/routes';
import type { ResourceRequestLog } from '../resources/request-log';
import { executeWorkflowSteps, type StepActionLog } from '../workflows/execute';
import { bindFinalActionCycleIdentity } from './action-cycle';
import {
  sameBridgeMethodSurface,
  type DiagnosticBridgeSnapshot,
  type ExecutePlanBehavior,
  type FinalExecutionObservation,
  type FinalExecutionPayload,
  type ImageProjectionHeader,
} from './execute-plan';

/**
 * Image upload/replace diagnostic drive (WP5 Slice 5-C).
 *
 * Two signal-first Action Cycles over one post-seal native workflow: upload A,
 * then replace with B. Every cycle uses one non-extending 8,000 ms deadline and
 * a raster-aware coherent capture. The harness never creates a blob URL, never
 * mutates the store, and never revokes a product-owned blob.
 */

const IMAGE_ROUTE = SETUP_ROUTE;

export interface ImageCycleReport {
  checkpoint: 'after-upload-current' | 'after-replacement-current';
  mode: 'upload' | 'replacement';
  outcome: 'PASS' | 'BUG' | 'HARNESS_BLOCKED';
  requiredChecks: readonly LegacyCompositeCheck[];
  checks: readonly ImageCheckResult[];
  harnessInvalid: boolean;
  observationId: string | null;
  wakeSource: WakeSource;
  fallbackPollCount: number;
  watchdogWaits: number;
  tornCount: number;
  rasterEvaluationCount: number;
  /** Signal-first expected-raster readiness attempts inside the one deadline. */
  rasterConvergenceAttempts: number;
  /** Reconciled fallback probes used by expected-raster readiness only. */
  rasterConvergenceFallbackPollCount: number;
  quiescenceFrames: number;
  timings: Readonly<Record<string, number | null>>;
  actionLogs: readonly StepActionLog[];
  diagnostics: readonly DiagnosticRecord[];
  detail: string;
}

export interface ImageDriveReport {
  cycles: readonly ImageCycleReport[];
  resources: readonly {
    logicalId: string;
    version: number;
    filename: string;
    byteLength: number;
    sha256: string;
    mimeType: string;
  }[];
  resourceManifestFingerprint: string;
  routeOwnership: readonly { logicalId: string; version: number; url: string }[];
  requestLog: ResourceRequestLog;
  preflight: readonly {
    logicalId: string;
    status: number | null;
    byteLength: number | null;
    mimeType: string | null;
    sha256: string | null;
    matches: boolean;
  }[];
}

export interface ExecuteImagePlanInput {
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
   * The Image executor places this exact object by reference in
   * `FinalExecutionObservation.envelope`; it never recompiles, looks up, or
   * reconstructs a profile.
   */
  envelope: MaterializedExecutionEnvelopeV1;
  resources: readonly ResolvedResource[];
  resourceManifestFingerprint: string;
  openPage?: typeof openFreshPage;
  now?: () => number;
}

export interface ExecuteImagePlanResult {
  behavior: ExecutePlanBehavior;
  image: ImageDriveReport | null;
  browserClose: BrowserCloseOutcome;
  environmentInvalid: boolean;
  /**
   * The exact envelope-bound final observation handoff for this executor run.
   * It is the canonical field the Diagnostic façade forwards; it is `null` only
   * before any family execution was entered (launch failure or a genuine
   * pre-behavior setup refusal).
   */
  finalObservation: FinalExecutionObservation | null;
}

interface BridgeInspection {
  available?: boolean;
  frozen?: unknown;
  methods?: unknown;
  version?: unknown;
  cursorA?: Partial<ObservationCursor> | null;
  cursorB?: Partial<ObservationCursor> | null;
  waiter?: { status?: unknown } | null;
  rasterProbe?: { isPromise?: unknown; schemaVersion?: unknown; hasObservation?: unknown } | null;
  rasterError?: unknown;
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

interface ResourcePreflightFact {
  logicalId: string;
  status: number | null;
  byteLength: number | null;
  mimeType: string | null;
  sha256: string | null;
  matches: boolean;
}

async function preflightResources(
  page: Page,
  resources: readonly ResolvedResource[],
): Promise<ResourcePreflightFact[]> {
  const facts = (await page.evaluate(
    async (urls: string[]) => {
      const output: {
        url: string;
        ok: boolean;
        status: number;
        byteLength: number;
        mimeType: string | null;
        sha256: string;
      }[] = [];
      for (const url of urls) {
        const response = await fetch(url);
        const buffer = await response.arrayBuffer();
        const digest = await crypto.subtle.digest('SHA-256', buffer);
        const sha256 = [...new Uint8Array(digest)]
          .map((byte) => byte.toString(16).padStart(2, '0'))
          .join('');
        output.push({
          url,
          ok: response.ok,
          status: response.status,
          byteLength: buffer.byteLength,
          mimeType: response.headers.get('content-type'),
          sha256,
        });
      }
      return output;
    },
    resources.map((resource) => resource.sameOriginUrl),
  )) as {
    url: string;
    ok: boolean;
    status: number;
    byteLength: number;
    mimeType: string | null;
    sha256: string;
  }[];
  return resources.map((resource) => {
    const fact = facts.find((entry) => entry.url === resource.sameOriginUrl) ?? null;
    return {
      logicalId: resource.logicalId,
      status: fact?.status ?? null,
      byteLength: fact?.byteLength ?? null,
      mimeType: fact?.mimeType ?? null,
      sha256: fact?.sha256 ?? null,
      matches:
        fact !== null &&
        fact.ok &&
        fact.byteLength === resource.byteLength &&
        fact.sha256 === resource.sha256 &&
        fact.mimeType === resource.mimeType,
    };
  });
}

function segmentSteps(
  steps: readonly WorkflowStep[],
): { checkpoint: 'after-upload-current' | 'after-replacement-current'; steps: WorkflowStep[] }[] {
  const segments: {
    checkpoint: 'after-upload-current' | 'after-replacement-current';
    steps: WorkflowStep[];
  }[] = [];
  let current: WorkflowStep[] = [];
  for (const step of steps) {
    current.push(step);
    if (step.checkpoint !== undefined) {
      segments.push({ checkpoint: step.checkpoint, steps: current });
      current = [];
    }
  }
  if (current.length > 0) {
    const last = segments[segments.length - 1];
    if (last) last.steps = [...last.steps, ...current];
  }
  return segments;
}

export async function executeImagePlan(
  input: ExecuteImagePlanInput,
): Promise<ExecuteImagePlanResult> {
  const now = input.now ?? (() => performance.now());
  const diagnostics: DiagnosticRecord[] = [];
  const resolutions: TargetResolution[] = [];
  const targetIds: string[] = [];
  let session: BrowserSession | null = null;
  let browserClose: BrowserCloseOutcome = { closed: true, detail: null };
  let environmentInvalid = false;
  let harnessInvalid = false;
  let outcome: Extract<Outcome, 'PASS' | 'BUG' | 'HARNESS_BLOCKED'> = 'HARNESS_BLOCKED';
  let detail = 'Image diagnostic drive did not complete.';
  const installedRef: { current: InstalledResourceRoutes | null } = { current: null };
  let imageReport: ImageDriveReport | null = null;
  let actionLogs: readonly StepActionLog[] = [];
  let wakeSource: WakeSource = 'none';
  let fallbackPollCount = 0;
  let observation: CoherentObservation | null = null;
  let bridgeContract: ExecutePlanBehavior['bridgeContract'] = null;
  let seal: ExecutePlanBehavior['seal'] = null;
  let requiredChecks: readonly LegacyCompositeCheck[] = input.plan.requiredChecks.map(
    (checkId) => ({
      checkId,
      passed: false,
    }),
  );
  const requiredSourcesAgree = true;
  const cycles: ImageCycleReport[] = [];
  const timings: Record<string, number | null> = {};
  let finalObservation: FinalExecutionObservation | null = null;

  const finish = (): ExecuteImagePlanResult => ({
    behavior: {
      outcome,
      requiredChecks,
      requiredSourcesAgree,
      harnessInvalid,
      diagnostics,
      resolutions,
      targetIds,
      // The image drive has no dedicated pre-behavior negative constructor; its
      // setup refusal keeps the existing behavior-terminal semantics.
      preBehaviorRefusal: null,
      seal,
      bridgeContract,
      action: null,
      actionLogs,
      cycle: null,
      observation,
      oracleInputs: null,
      wakeSource,
      fallbackPollCount,
      profile: {
        readinessProfileId: IMAGE_RASTER_ACTION_CYCLE_PROFILE.profileId,
        readinessDeadlineMs: IMAGE_RASTER_ACTION_CYCLE_PROFILE.deadlineMs,
        readinessStableFrames: IMAGE_RASTER_ACTION_CYCLE_PROFILE.stableFrames,
        readinessTimingCategory: IMAGE_RASTER_ACTION_CYCLE_PROFILE.timingCategory,
        oracleProfileId: 'image-upload-replace-v1',
      },
      timings,
      detail,
    },
    image: imageReport,
    browserClose,
    environmentInvalid,
    finalObservation,
  });

  try {
    session = await (input.openPage ?? openFreshPage)({
      baseUrl: input.allocation.baseUrl,
      route: IMAGE_ROUTE,
      environment: input.environment,
      navigationTimeoutMs: 60_000,
      beforeNavigate: async (context) => {
        installedRef.current = await registerResourceRoutes({
          context,
          origin: new URL(input.allocation.baseUrl).origin,
          resources: input.resources,
          runId: input.allocation.runId,
        });
      },
    });
    const { page } = session;
    // Read the callback-written install once through an explicit local so the
    // closure assignment is not narrowed away to `never`.
    const installed = installedRef.current;

    await page.waitForFunction(
      (name) => Boolean((window as unknown as Record<string, unknown>)[name]),
      OBSERVATION_GLOBAL_NAME,
      { timeout: 30_000 },
    );

    // ── Precondition: inline bridge v7 contract inspection ──────────────────
    const inspection = (await page.evaluate(
      buildDoctorBridgeInspectionScript(),
    )) as BridgeInspection;
    const observedMethods = asStringArray(inspection.methods);
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
    const bridgePreconditions: Array<{ code: DiagnosticCode; detail: string }> = [];
    if (inspection.available !== true) {
      bridgePreconditions.push({
        code: 'BRIDGE_UNAVAILABLE',
        detail: 'The observation bridge was not available.',
      });
    } else {
      if (bridgeContract.version !== OBSERVATION_BRIDGE_VERSION) {
        bridgePreconditions.push({
          code: 'BRIDGE_VERSION_MISMATCH',
          detail: `Observation bridge version ${String(bridgeContract.version)} does not match required v${OBSERVATION_BRIDGE_VERSION}.`,
        });
      }
      if (!sameBridgeMethodSurface(observedMethods)) {
        bridgePreconditions.push({
          code: 'BRIDGE_SURFACE_MISMATCH',
          detail: `Observation bridge exposes ${observedMethods.join(', ') || 'no callable methods'}, not the exact ${OBSERVATION_BRIDGE_READ_ONLY_METHODS.length}-method surface.`,
        });
      }
      if (bridgeContract.frozen !== true) {
        bridgePreconditions.push({
          code: 'BRIDGE_NOT_FROZEN',
          detail: 'Observation bridge object is not frozen.',
        });
      }
      if (!bridgeContract.cursorValid || !bridgeContract.cursorStable) {
        bridgePreconditions.push({
          code: 'BRIDGE_CURSOR_INVALID',
          detail: 'The observation cursor is invalid or unstable.',
        });
      }
      if (!bridgeContract.waiterBounded) {
        bridgePreconditions.push({
          code: 'BRIDGE_WAITER_UNBOUNDED',
          detail: 'The bounded waiter did not report a timeout.',
        });
      }
      if (inspection.rasterProbe === null || inspection.rasterProbe === undefined) {
        bridgePreconditions.push({
          code: 'RASTER_SCHEMA_UNSUPPORTED',
          detail: 'The bridge exposed no safe raster probe.',
        });
      } else if (
        inspection.rasterProbe.isPromise !== true ||
        asNumber(inspection.rasterProbe.schemaVersion) !== 3
      ) {
        bridgePreconditions.push({
          code: 'RASTER_SCHEMA_UNSUPPORTED',
          detail: `The bridge raster probe resolved to ${String(inspection.rasterProbe.schemaVersion)} (promise=${String(inspection.rasterProbe.isPromise)}), not raster schema 3.`,
        });
      }
    }
    if (bridgePreconditions.length > 0) {
      harnessInvalid = true;
      for (const precondition of bridgePreconditions) {
        diagnostics.push(createDiagnostic(precondition.code, precondition.detail));
      }
      detail = `Observation bridge v${OBSERVATION_BRIDGE_VERSION} precondition failed: ${bridgePreconditions.map((entry) => entry.code).join(', ')}.`;
      return finish();
    }

    // ── Resource preflight (route ownership proof only) ─────────────────────
    const preflight = await preflightResources(page, input.resources);
    if (preflight.some((entry) => !entry.matches)) {
      harnessInvalid = true;
      diagnostics.push(
        createDiagnostic(
          'RESOURCE_BYTES_MISMATCH',
          'The same-origin route preflight did not deliver the exact manifest bytes.',
          {
            context: {
              resources: preflight
                .map((entry) => `${entry.logicalId}=${String(entry.matches)}`)
                .join(','),
            },
          },
        ),
      );
      detail = 'Resource route preflight did not deliver the exact manifest bytes.';
      return finish();
    }

    // ── Seal the two-layout Image constructor ───────────────────────────────
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
      diagnostics.push(
        createDiagnostic(code, refusal, { context: { runId: input.allocation.runId } }),
      );
      detail = `Setup did not seal: ${refusal}`;
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

    // ── Resolve exactly one active-layout Image target ──────────────────────
    const elements = (await page.evaluate(bridgeCallScript('return bridge.elements();'))) as
      | {
          elements: readonly {
            id: string;
            kind: string;
            parentId: string | null;
            mounted: boolean;
          }[];
        }
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
      if (resolution.status === 'resolved' && resolution.target)
        targetIds.push(resolution.target.elementId);
    }
    if (targetIds.length === 0 || resolutions.some((entry) => entry.status !== 'resolved')) {
      harnessInvalid = true;
      detail = `Target resolution blocked before action: ${resolutions
        .map((entry) => `${entry.role}=${entry.status}(${entry.matchCount})`)
        .join(', ')}.`;
      return finish();
    }
    const targetId = targetIds[0] as string;
    const activeLayoutId = seal.activeLayoutId;

    const normalized = input.adapter.normalizeResult(
      resolutions,
      input.intent.capability,
      input.plan.requiredChecks,
    );
    const allChecks = normalized.requiredChecks;
    const uploadChecks = allChecks.filter((checkId) => checkId !== IMAGE_CONTENT_DISTINCT_CHECK);
    const replacementChecks = [...allChecks, IMAGE_REPLACE_CONTROL_READY_CHECK];

    // Pre-action hit point + preconditions.
    const preGeometry = (await page.evaluate(
      bridgeCallScript(`return bridge.geometry(${JSON.stringify(targetId)});`),
    )) as StampedGeometryView;
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
      canonical: { layoutItems: preSnapshot.layoutItems, expectedLayoutId: seal.activeLayoutId },
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
        `return await bridge.waitForIdle({ targets: ${JSON.stringify(targetIds)}, stableFrames: ${IMAGE_RASTER_ACTION_CYCLE_PROFILE.stableFrames}, timeoutMs: ${IMAGE_RASTER_ACTION_CYCLE_PROFILE.deadlineMs} });`,
      ),
    );

    const expectedFrame = readExpectedFrame(input.intent.expected);
    if (expectedFrame === null) {
      harnessInvalid = true;
      diagnostics.push(
        createDiagnostic(
          'UNUSABLE_EVIDENCE',
          'The case expectation declares no finite expected imageFrame.',
        ),
      );
      detail = 'The case declares no expected imageFrame.';
      return finish();
    }

    /**
     * Assembles the source-owned Image final observation at a point where the
     * mode/target/layout/frame/resource/upload/oracle/raster/readiness/evidence
     * facts coexist, retains the exact planning envelope by reference, and binds
     * the one Action Cycle identity derived from that envelope. It is a
     * void-returning closure assigned into the executor-owned
     * `finalObservation`; the legacy report is left untouched for S3.
     */
    const bindImageObservation = (facts: {
      mode: 'upload' | 'replacement';
      expectedResource: ResolvedResource;
      acceptedUpload: ImageFinalPayload['acceptedUpload'];
      oracle: ImageFinalPayload['oracle'];
      raster: unknown;
      readiness: ImageFinalPayload['readiness']['observation'];
      observationId: string | null;
    }): void => {
      const actionCycleId = `final:${input.allocation.runId}:${input.caseId}:image-upload-replace`;
      const payload: FinalExecutionPayload = {
        evaluatorKind: 'image-upload-replace',
        projection: buildImageProjectionHeader(cycles, actionCycleId),
        mode: facts.mode,
        targetId,
        expectedLayoutId: activeLayoutId,
        expectedFrame,
        expectedResource: imageKernelResourceFact(facts.expectedResource),
        acceptedUpload: facts.acceptedUpload,
        oracle: facts.oracle,
        raster: facts.raster,
        readiness: {
          policy: imageReadinessPolicy(input.envelope),
          observation: facts.readiness,
        },
        evidence: imageEvidenceFacts(
          input.envelope.correctnessProfile.requiredAuthoritativeEvidence,
          facts.oracle === null ? 'malformed' : facts.oracle.primitiveFacts.authority,
        ),
      };
      finalObservation = Object.freeze({
        envelope: input.envelope,
        actionCycle: bindFinalActionCycleIdentity({ envelope: input.envelope, actionCycleId }),
        payload: Object.freeze(payload),
        observationId: facts.observationId,
      });
    };

    const resourceByRole = (role: string): ResolvedResource | null => {
      const ref = (input.fixture.resourceRefs ?? []).find((entry) => entry.role === role) ?? null;
      if (ref === null) return null;
      return findResolvedResource(input.resources, ref.logicalId, ref.version);
    };

    const segments = segmentSteps(input.workflowSteps);
    if (segments.length !== 2) {
      harnessInvalid = true;
      diagnostics.push(
        createDiagnostic(
          'WORKFLOW_STEPS_UNAVAILABLE',
          'The image workflow must declare exactly two checkpoints.',
        ),
      );
      detail = 'The image workflow does not declare exactly two checkpoints.';
      return finish();
    }

    let acceptedUpload: {
      sourceSha256: string;
      rgbaSha256: string;
      probes: readonly { probeId: string; rgba: readonly number[] }[];
      snapshot: unknown;
    } | null = null;

    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index] as {
        checkpoint: 'after-upload-current' | 'after-replacement-current';
        steps: WorkflowStep[];
      };
      const mode = segment.checkpoint === 'after-upload-current' ? 'upload' : 'replacement';
      const expectedResource = resourceByRole(
        mode === 'upload' ? 'upload-initial' : 'replace-final',
      );
      if (expectedResource === null) {
        harnessInvalid = true;
        diagnostics.push(
          createDiagnostic(
            'RESOURCE_UNDECLARED',
            `No resolved resource is bound to the ${mode} role.`,
          ),
        );
        detail = `No resolved resource is bound to the ${mode} role.`;
        return finish();
      }
      const cycleBaselineCursor = (await page.evaluate(
        bridgeCallScript('return bridge.cursor();'),
      )) as ObservationCursor;
      const cycleBaselineSnapshot = (await page.evaluate(
        bridgeCallScript('return bridge.snapshot();'),
      )) as DiagnosticBridgeSnapshot;
      const cycleBaselineLayer = findCanonicalImageLayer(
        cycleBaselineSnapshot.layoutItems,
        targetId,
      );
      if (!isWellFormedCursor(cycleBaselineCursor) || cycleBaselineLayer === null) {
        harnessInvalid = true;
        diagnostics.push(
          createDiagnostic('UNUSABLE_EVIDENCE', `The ${mode} cycle baseline was malformed.`),
        );
        detail = `The ${mode} cycle baseline was malformed.`;
        return finish();
      }

      const cycleStart = now();
      const cycleDeadline = cycleStart + IMAGE_RASTER_ACTION_CYCLE_PROFILE.deadlineMs;
      const cycleDiagnostics: DiagnosticRecord[] = [];
      const torn: TornObservation[] = [];
      let rasterEvaluationCount = 0;
      let replaceControlReady: boolean | null = null;

      const performAction = async () => {
        const fresh = (await page.evaluate(
          bridgeCallScript(`return bridge.geometry(${JSON.stringify(targetId)});`),
        )) as StampedGeometryView;
        const stepResult = await executeWorkflowSteps({
          steps: segment.steps,
          operation: input.intent.operations[0],
          resolutions,
          points: { [targetId]: fresh.hitPoint ?? { x: Number.NaN, y: Number.NaN } },
          handlers: {
            pointerDrag: async () => ({
              ok: false,
              detail: 'pointer.drag is not delivered for this binding.',
            }),
            pointerClick: async () => {
              const dispatch = await pointerClick({
                page,
                target: { hitPoint: fresh.hitPoint, viewportRect: fresh.viewportRect },
              });
              if (!dispatch.ok) return { ok: false, detail: dispatch.detail, code: dispatch.code };
              return {
                ok: true,
                detail: `Native pointer click at (${dispatch.log.point.x}, ${dispatch.log.point.y}).`,
              };
            },
            controlActivate: async (request) => {
              const result = await activateControl({ page, accessibleName: request.control });
              if (mode === 'replacement' && request.control === 'Replace image') {
                replaceControlReady = result.ok;
              }
              return result.ok
                ? { ok: true, detail: result.detail }
                : { ok: false, detail: result.detail, code: result.code };
            },
            keyboardPress: async () => ({
              ok: false,
              detail: 'keyboard.press is not delivered for this binding.',
            }),
            fileInputSet: async (request) => {
              const resource = resourceByRole(request.resourceRole);
              if (resource === null) {
                return {
                  ok: false,
                  detail: `No resolved resource is bound to role "${request.resourceRole}".`,
                  code: 'RESOURCE_UNDECLARED' as DiagnosticCode,
                };
              }
              const result = await setFileInput({
                page,
                dialogAccessibleName: request.dialogAccessibleName,
                accept: request.accept,
                resource,
              });
              return result.ok
                ? { ok: true, detail: result.detail }
                : { ok: false, detail: result.detail, code: result.code };
            },
          },
        });
        actionLogs = [...actionLogs, ...stepResult.logs];
        if (!stepResult.ok) {
          return {
            ok: false,
            detail: stepResult.finding.detail,
            code: stepResult.finding.code,
            at: new Date().toISOString(),
          };
        }
        return {
          ok: true,
          detail: `Native ${mode} workflow segment dispatched.`,
          at: new Date().toISOString(),
        };
      };

      const evaluateCausalTransition = async (): Promise<CausalPredicateResult> => {
        const snapshot = (await page.evaluate(
          bridgeCallScript('return bridge.snapshot();'),
        )) as DiagnosticBridgeSnapshot;
        const layer = findCanonicalImageLayer(snapshot.layoutItems, targetId);
        const revisionAdvanced = snapshot.observation.revision > cycleBaselineCursor.revision;
        if (layer === null) {
          return {
            satisfied: false,
            detail: `Target "${targetId}" canonical layer is unavailable.`,
          };
        }
        const sourceChanged =
          mode === 'upload'
            ? cycleBaselineLayer.src === null && layer.src !== null
            : layer.src !== null &&
              cycleBaselineLayer.src !== null &&
              layer.src !== cycleBaselineLayer.src;
        const stableFrame =
          layer.frame.x === cycleBaselineLayer.frame.x &&
          layer.frame.y === cycleBaselineLayer.frame.y &&
          layer.frame.width === cycleBaselineLayer.frame.width &&
          layer.frame.height === cycleBaselineLayer.frame.height;
        return {
          satisfied:
            revisionAdvanced &&
            sourceChanged &&
            layer.placeholder &&
            layer.testedWithImage &&
            layer.parentLayoutId === activeLayoutId &&
            stableFrame,
          detail: `revision ${snapshot.observation.revision} vs ${cycleBaselineCursor.revision}; sourceChanged=${String(sourceChanged)}; stableFrame=${String(stableFrame)}.`,
        };
      };

      const action = await performAction();
      timings[`${mode}.actionMs`] = Math.round(now() - cycleStart);
      if (!action.ok) {
        const code = action.code ?? 'HIT_POINT_UNAVAILABLE';
        // R10: after an accepted A upload, a stable authoritative absence or
        // disabled/hidden state of the exact Replace image control is a product
        // defect (the product failed to expose the required continuation), not
        // a harness failure. Multiple controls stay HARNESS_BLOCKED (ambiguity).
        const replaceControlProductDefect =
          mode === 'replacement' &&
          code === 'PUBLIC_CONTROL_UNAVAILABLE' &&
          acceptedUpload !== null;
        cycleDiagnostics.push(
          createDiagnostic(
            replaceControlProductDefect ? 'PRODUCT_TRANSITION_NOT_OBSERVED' : code,
            action.detail,
            {
              context: { phase: 'action', mode },
            },
          ),
        );
        cycles.push(
          buildHarnessCycle(
            mode,
            segment.checkpoint,
            cycleDiagnostics,
            torn,
            action,
            now() - cycleStart,
          ),
        );
        bindImageObservation({
          mode,
          expectedResource,
          acceptedUpload,
          oracle: null,
          raster: null,
          readiness: {
            outcome: 'not-attempted',
            authority: 'missing',
            wakeSource: 'none',
            fallbackPollCount: 0,
            watchdogWaits: 0,
            attempts: 0,
            tornCount: 0,
            mismatches: [],
            detail: `The ${mode} action was refused before dispatch: ${action.detail}`,
          },
          observationId: null,
        });
        harnessInvalid = !replaceControlProductDefect;
        outcome = replaceControlProductDefect ? 'BUG' : 'HARNESS_BLOCKED';
        detail = replaceControlProductDefect
          ? `Replace control was not exposed after an accepted upload: ${action.detail}`
          : `Native ${mode} action was refused before dispatch: ${action.detail}`;
        imageReport = buildImageReport(cycles, input, installed, preflight);
        return finish();
      }

      const gate = await awaitCausalTransition({
        profile: IMAGE_RASTER_ACTION_CYCLE_PROFILE,
        now,
        armedAt: cycleStart,
        armCursor: cycleBaselineCursor,
        waitForChange: async (after, timeoutMs) =>
          (await page.evaluate(
            bridgeAsyncScript(
              `return await bridge.waitForChange({ after: ${JSON.stringify(after)}, timeoutMs: ${timeoutMs} });`,
            ),
          )) as WaitForChangeOutcome,
        readCursor: async () =>
          (await page.evaluate(bridgeCallScript('return bridge.cursor();'))) as ObservationCursor,
        evaluateCausalTransition,
      });
      timings[`${mode}.transitionMs`] = Math.round(now() - cycleStart);

      if (gate.status === 'invalidated' || gate.status === 'deadline-exceeded') {
        if (gate.status === 'invalidated') {
          cycleDiagnostics.push(
            createDiagnostic(
              'UNUSABLE_EVIDENCE',
              `Readiness authority invalidated: ${gate.invalidatedReason ?? 'unknown'}.`,
            ),
          );
        } else {
          cycleDiagnostics.push(
            createDiagnostic(
              'PRODUCT_TRANSITION_NOT_OBSERVED',
              `No required ${mode} causal transition within ${IMAGE_RASTER_ACTION_CYCLE_PROFILE.deadlineMs}ms.`,
            ),
          );
        }
        cycles.push(
          buildHarnessCycle(
            mode,
            segment.checkpoint,
            cycleDiagnostics,
            torn,
            action,
            now() - cycleStart,
            gate,
          ),
        );
        cycles[cycles.length - 1] = {
          ...(cycles[cycles.length - 1] as ImageCycleReport),
          outcome: gate.status === 'deadline-exceeded' ? 'BUG' : 'HARNESS_BLOCKED',
          harnessInvalid: gate.status !== 'deadline-exceeded',
        };
        bindImageObservation({
          mode,
          expectedResource,
          acceptedUpload,
          oracle: null,
          raster: null,
          readiness: {
            outcome: gate.status === 'deadline-exceeded' ? 'deadline-exceeded' : 'unusable',
            authority: gate.status === 'deadline-exceeded' ? 'current' : 'unavailable',
            wakeSource: gate.wakeSource,
            fallbackPollCount: gate.fallbackPollCount,
            watchdogWaits: gate.watchdogWaits,
            attempts: 0,
            tornCount: torn.length,
            mismatches: [],
            detail:
              gate.status === 'deadline-exceeded'
                ? `No required ${mode} causal transition within ${IMAGE_RASTER_ACTION_CYCLE_PROFILE.deadlineMs}ms.`
                : `Readiness authority invalidated: ${gate.invalidatedReason ?? 'unknown'}.`,
          },
          observationId: null,
        });
        harnessInvalid = gate.status !== 'deadline-exceeded';
        outcome = gate.status === 'deadline-exceeded' ? 'BUG' : 'HARNESS_BLOCKED';
        detail =
          gate.status === 'deadline-exceeded'
            ? `Product ${mode} transition not observed within the deadline (fallback probes: ${gate.fallbackPollCount}).`
            : `Readiness authority invalidated: ${gate.invalidatedReason ?? 'unknown'}.`;
        wakeSource = gate.wakeSource;
        fallbackPollCount = gate.fallbackPollCount;
        imageReport = buildImageReport(cycles, input, installed, preflight);
        return finish();
      }

      const readRaster = async (id: string): Promise<RasterBracketView> => {
        rasterEvaluationCount += 1;
        return (await page.evaluate(
          bridgeAsyncScript(`return await bridge.raster(${JSON.stringify(id)});`),
        )) as RasterBracketView;
      };

      const readinessResource: ExpectedRasterResource = {
        sha256: expectedResource.sha256,
        byteLength: expectedResource.byteLength,
        mimeType: expectedResource.mimeType,
        dimensions: expectedResource.dimensions,
        probes: expectedResource.structuralVisual.probes.map((probe) => ({
          id: probe.id,
          x: probe.x,
          y: probe.y,
          expectedRgba: probe.expectedRgba,
          channelTolerance: probe.channelTolerance,
        })),
      };
      const readinessAcceptedUpload: AcceptedRasterUpload | null =
        mode === 'replacement' && acceptedUpload !== null
          ? {
              sourceSha256: acceptedUpload.sourceSha256,
              rgbaSha256: acceptedUpload.rgbaSha256,
              probes: acceptedUpload.probes,
            }
          : null;
      const evaluateRasterCurrentness = (view: RasterBracketView | null) =>
        evaluateExpectedRasterCurrentness({
          raster: view,
          targetId,
          expectedResource: readinessResource,
          expectedFrame,
          mode,
          acceptedUpload: readinessAcceptedUpload,
        });

      // ── R6: expected-raster convergence inside the one cycle deadline. ────
      // After the semantic wake, a well-formed but nonmatching live raster stays
      // a non-converged readiness candidate: it is re-read signal-first (100 ms
      // watchdog, then the bounded 100/200/250 ms cadence) and re-captured
      // coherently until it matches, or the *same* non-extending deadline turns
      // it into a terminal product BUG. Transient stale A after B therefore
      // never becomes a premature Oracle BUG.
      let convergenceAttempts = 0;
      let convergenceFallbackPollCount = 0;
      const convergenceMismatches: string[] = [];
      let convergenceDiagnostic: DiagnosticRecord | null = null;
      let convergenceTerminalDetail: string | null = null;
      let capture: Awaited<ReturnType<typeof captureCoherentObservation>> | null = null;
      let raster: RasterBracketView | null = null;
      let settleBeforeFirstRead = false;

      for (;;) {
        const readiness = await awaitExpectedRasterConvergence({
          profile: IMAGE_RASTER_ACTION_CYCLE_PROFILE,
          now,
          deadlineAt: cycleDeadline,
          armCursor: gate.cursor ?? cycleBaselineCursor,
          waitForChange: async (after, timeoutMs) =>
            (await page.evaluate(
              bridgeAsyncScript(
                `return await bridge.waitForChange({ after: ${JSON.stringify(after)}, timeoutMs: ${timeoutMs} });`,
              ),
            )) as WaitForChangeOutcome,
          readCursor: async () =>
            (await page.evaluate(bridgeCallScript('return bridge.cursor();'))) as ObservationCursor,
          readRaster: () => readRaster(targetId),
          evaluate: (view) => evaluateRasterCurrentness(view),
          settleBeforeFirstRead,
        });
        convergenceAttempts += readiness.attempts;
        convergenceFallbackPollCount += readiness.fallbackPollCount;
        convergenceMismatches.push(...readiness.mismatches);
        if (readiness.status === 'unusable') {
          convergenceDiagnostic =
            readiness.diagnostic ?? createDiagnostic('UNUSABLE_EVIDENCE', readiness.detail);
          break;
        }
        if (readiness.status === 'deadline-exceeded') {
          convergenceTerminalDetail = `${readiness.attempts} signal-first readiness attempt(s) never produced the expected ${mode} raster: ${readiness.lastDetail}`;
          break;
        }

        // Quiescence first, then the coherent A0 → snapshot → G0/G1 → R0/R1 → A1
        // bracket; both stay inside the same deadline.
        const remaining = cycleDeadline - now();
        try {
          await page.evaluate(
            bridgeAsyncScript(
              `return await bridge.waitForIdle({ targets: ${JSON.stringify(targetIds)}, stableFrames: ${IMAGE_RASTER_ACTION_CYCLE_PROFILE.stableFrames}, timeoutMs: ${Math.max(0, Math.round(remaining))} });`,
            ),
          );
        } catch (error) {
          cycleDiagnostics.push(
            createDiagnostic(
              now() >= cycleDeadline ? 'READINESS_DEADLINE_EXCEEDED' : 'UNUSABLE_EVIDENCE',
              `Renderer quiescence did not settle: ${(error as Error).message}`,
            ),
          );
          cycles.push(
            buildHarnessCycle(
              mode,
              segment.checkpoint,
              cycleDiagnostics,
              torn,
              action,
              now() - cycleStart,
              gate,
            ),
          );
          bindImageObservation({
            mode,
            expectedResource,
            acceptedUpload,
            oracle: null,
            raster: null,
            readiness: {
              outcome: 'unusable',
              authority: 'unavailable',
              wakeSource: gate.wakeSource,
              fallbackPollCount: gate.fallbackPollCount,
              watchdogWaits: gate.watchdogWaits,
              attempts: convergenceAttempts,
              tornCount: torn.length,
              mismatches: [...convergenceMismatches],
              detail: `Renderer quiescence did not settle: ${(error as Error).message}`,
            },
            observationId: null,
          });
          harnessInvalid = true;
          outcome = 'HARNESS_BLOCKED';
          detail = `Target-aware quiescence did not settle for the ${mode} cycle.`;
          wakeSource = gate.wakeSource;
          fallbackPollCount = gate.fallbackPollCount;
          imageReport = buildImageReport(cycles, input, installed, preflight);
          return finish();
        }

        const candidate = await captureCoherentObservation({
          now,
          deadlineAt: cycleDeadline,
          readCursor: async () =>
            (await page.evaluate(bridgeCallScript('return bridge.cursor();'))) as ObservationCursor,
          readSnapshot: async () =>
            (await page.evaluate(
              bridgeCallScript('return bridge.snapshot();'),
            )) as DiagnosticBridgeSnapshot,
          readGeometry: async (id) =>
            (await page.evaluate(
              bridgeCallScript(`return bridge.geometry(${JSON.stringify(id)});`),
            )) as StampedGeometryView,
          targetIds,
          stableRendererFingerprint: null,
          readRaster,
        });

        if (!candidate.ok) {
          cycleDiagnostics.push(
            createDiagnostic(
              'OBSERVATION_TORN',
              `The ${mode} coherent capture was torn (${candidate.code}).`,
            ),
          );
          cycles.push(
            buildHarnessCycle(
              mode,
              segment.checkpoint,
              cycleDiagnostics,
              candidate.torn,
              action,
              now() - cycleStart,
              gate,
            ),
          );
          bindImageObservation({
            mode,
            expectedResource,
            acceptedUpload,
            oracle: null,
            raster: null,
            readiness: {
              outcome: 'unusable',
              authority: 'torn',
              wakeSource: gate.wakeSource,
              fallbackPollCount: gate.fallbackPollCount,
              watchdogWaits: gate.watchdogWaits,
              attempts: convergenceAttempts,
              tornCount: candidate.torn.length,
              mismatches: [...convergenceMismatches],
              detail: `The ${mode} coherent capture was torn (${candidate.code}).`,
            },
            observationId: null,
          });
          harnessInvalid = true;
          outcome = 'HARNESS_BLOCKED';
          detail = `The ${mode} observation capture was unusable: ${candidate.code}.`;
          wakeSource = gate.wakeSource;
          fallbackPollCount = gate.fallbackPollCount;
          imageReport = buildImageReport(cycles, input, installed, preflight);
          return finish();
        }

        const acceptedEvaluation = evaluateRasterCurrentness(
          candidate.observation.raster[targetId] ?? null,
        );
        if (acceptedEvaluation.status === 'converged') {
          capture = candidate;
          raster = candidate.observation.raster[targetId] ?? null;
          break;
        }
        if (acceptedEvaluation.status === 'unusable') {
          convergenceDiagnostic =
            acceptedEvaluation.diagnostic ??
            createDiagnostic('UNUSABLE_EVIDENCE', acceptedEvaluation.detail);
          break;
        }
        convergenceMismatches.push(acceptedEvaluation.detail);
        if (now() >= cycleDeadline) {
          convergenceTerminalDetail = `The accepted ${mode} coherent capture never converged to the expected raster by the deadline: ${acceptedEvaluation.detail}`;
          break;
        }
        settleBeforeFirstRead = true;
      }

      if (convergenceDiagnostic !== null) {
        cycleDiagnostics.push(convergenceDiagnostic);
        cycles.push(
          buildHarnessCycle(
            mode,
            segment.checkpoint,
            cycleDiagnostics,
            torn,
            action,
            now() - cycleStart,
            gate,
          ),
        );
        bindImageObservation({
          mode,
          expectedResource,
          acceptedUpload,
          oracle: null,
          raster: null,
          readiness: {
            outcome: 'unusable',
            authority: 'unavailable',
            wakeSource: gate.wakeSource,
            fallbackPollCount: gate.fallbackPollCount,
            watchdogWaits: gate.watchdogWaits,
            attempts: convergenceAttempts,
            tornCount: torn.length,
            mismatches: [...convergenceMismatches],
            detail: convergenceDiagnostic.detail,
          },
          observationId: null,
        });
        harnessInvalid = true;
        outcome = 'HARNESS_BLOCKED';
        detail = `Expected-raster readiness was unusable for the ${mode} cycle: ${convergenceDiagnostic.detail}`;
        wakeSource = gate.wakeSource;
        fallbackPollCount = gate.fallbackPollCount;
        imageReport = buildImageReport(cycles, input, installed, preflight);
        return finish();
      }

      if (convergenceTerminalDetail !== null || capture === null || raster === null) {
        // R6: the safe file action happened and trustworthy authority never
        // converged to the required product result. This is a terminal product
        // BUG at the original deadline, never a harness failure.
        const terminalDetail =
          convergenceTerminalDetail ?? `The ${mode} expected raster never converged.`;
        cycleDiagnostics.push(createDiagnostic('PRODUCT_TRANSITION_NOT_OBSERVED', terminalDetail));
        const terminalChecks = (mode === 'upload' ? uploadChecks : replacementChecks).map(
          (checkId): LegacyCompositeCheck => ({
            checkId,
            passed:
              checkId === IMAGE_REPLACE_CONTROL_READY_CHECK ? replaceControlReady === true : false,
          }),
        );
        cycles.push({
          checkpoint: segment.checkpoint,
          mode,
          outcome: 'BUG',
          requiredChecks: terminalChecks,
          checks: [],
          harnessInvalid: false,
          observationId: null,
          wakeSource: gate.wakeSource,
          fallbackPollCount: gate.fallbackPollCount,
          watchdogWaits: gate.watchdogWaits,
          tornCount: torn.length,
          rasterEvaluationCount,
          rasterConvergenceAttempts: convergenceAttempts,
          rasterConvergenceFallbackPollCount: convergenceFallbackPollCount,
          quiescenceFrames: IMAGE_RASTER_ACTION_CYCLE_PROFILE.stableFrames,
          timings: {
            actionMs: timings[`${mode}.actionMs`] ?? null,
            transitionMs: timings[`${mode}.transitionMs`] ?? null,
            totalMs: Math.round(now() - cycleStart),
          },
          actionLogs,
          diagnostics: cycleDiagnostics,
          detail: `Image ${mode} cycle BUG (expected raster never converged).`,
        });
        bindImageObservation({
          mode,
          expectedResource,
          acceptedUpload,
          oracle: null,
          raster,
          readiness: {
            outcome: 'deadline-exceeded',
            authority: 'current',
            wakeSource: gate.wakeSource,
            fallbackPollCount: gate.fallbackPollCount,
            watchdogWaits: gate.watchdogWaits,
            attempts: convergenceAttempts,
            tornCount: torn.length,
            mismatches: [...convergenceMismatches],
            detail: terminalDetail,
          },
          observationId: null,
        });
        diagnostics.push(...cycleDiagnostics);
        const mergedTerminal = new Map(requiredChecks.map((check) => [check.checkId, check]));
        for (const check of terminalChecks) mergedTerminal.set(check.checkId, check);
        requiredChecks = [...mergedTerminal.values()];
        harnessInvalid = false;
        outcome = 'BUG';
        detail = `Image ${mode} checkpoint BUG: the expected raster did not converge by the one deadline (${convergenceMismatches.length} nonmatching readiness attempt(s)).`;
        wakeSource = gate.wakeSource;
        fallbackPollCount = gate.fallbackPollCount;
        imageReport = buildImageReport(cycles, input, installed, preflight);
        return finish();
      }

      observation = capture.observation;

      const oracleInput: ImageOracleInput = {
        mode,
        targetId,
        expectedLayoutId: seal.activeLayoutId,
        expectedFrame,
        expectedResource: {
          logicalId: expectedResource.logicalId,
          version: expectedResource.version,
          sha256: expectedResource.sha256,
          byteLength: expectedResource.byteLength,
          mimeType: expectedResource.mimeType,
          dimensions: expectedResource.dimensions,
          probes: expectedResource.structuralVisual.probes.map(
            (probe): ResourceProbe => ({
              id: probe.id,
              x: probe.x,
              y: probe.y,
              expectedRgba: probe.expectedRgba,
              channelTolerance: probe.channelTolerance,
            }),
          ),
        },
        acceptedUpload:
          mode === 'replacement' && acceptedUpload !== null
            ? {
                sourceSha256: acceptedUpload.sourceSha256,
                rgbaSha256: acceptedUpload.rgbaSha256,
                probes: acceptedUpload.probes,
              }
            : null,
        baselineSnapshot: cycleBaselineSnapshot.layoutItems,
        observedSnapshot: capture.observation.snapshot.layoutItems,
        raster,
        expectedMinRenderedWidth:
          mode === 'replacement' && typeof input.intent.expected.minimumRenderedWidth === 'number'
            ? (input.intent.expected.minimumRenderedWidth as number)
            : null,
      };
      const evaluation = evaluateImageOracle(oracleInput);
      cycleDiagnostics.push(
        ...evaluation.diagnostics.map((entry) =>
          createDiagnostic('UNUSABLE_EVIDENCE', entry.detail),
        ),
      );
      const cycleRequiredChecks = (mode === 'upload' ? uploadChecks : replacementChecks).map(
        (checkId) => ({
          checkId,
          passed:
            checkId === IMAGE_REPLACE_CONTROL_READY_CHECK
              ? replaceControlReady === true
              : (evaluation.checks.find((check) => check.checkId === checkId)?.passed ?? false),
        }),
      );
      const mergedChecks = new Map(requiredChecks.map((check) => [check.checkId, check]));
      for (const check of cycleRequiredChecks) mergedChecks.set(check.checkId, check);
      requiredChecks = [...mergedChecks.values()];
      const cycleOutcome = evaluation.harnessInvalid
        ? 'HARNESS_BLOCKED'
        : cycleRequiredChecks.every((check) => check.passed)
          ? 'PASS'
          : 'BUG';

      const cycleReport: ImageCycleReport = {
        checkpoint: segment.checkpoint,
        mode,
        outcome: cycleOutcome,
        requiredChecks: cycleRequiredChecks,
        checks: evaluation.checks,
        harnessInvalid: evaluation.harnessInvalid,
        observationId: capture.observation.observationId,
        wakeSource: gate.wakeSource,
        fallbackPollCount: gate.fallbackPollCount,
        watchdogWaits: gate.watchdogWaits,
        tornCount: capture.torn.length,
        rasterEvaluationCount,
        rasterConvergenceAttempts: convergenceAttempts,
        rasterConvergenceFallbackPollCount: convergenceFallbackPollCount,
        quiescenceFrames: IMAGE_RASTER_ACTION_CYCLE_PROFILE.stableFrames,
        timings: {
          actionMs: timings[`${mode}.actionMs`] ?? null,
          transitionMs: timings[`${mode}.transitionMs`] ?? null,
          totalMs: Math.round(now() - cycleStart),
        },
        actionLogs: actionLogs,
        diagnostics: cycleDiagnostics,
        detail: `Image ${mode} cycle ${cycleOutcome}.`,
      };
      cycles.push(cycleReport);
      bindImageObservation({
        mode,
        expectedResource,
        acceptedUpload: oracleInput.acceptedUpload,
        oracle: { primitiveFacts: evaluation.primitiveFacts, diagnostics: evaluation.diagnostics },
        raster,
        readiness: {
          outcome: 'converged',
          authority: 'current',
          wakeSource: gate.wakeSource,
          fallbackPollCount: gate.fallbackPollCount,
          watchdogWaits: gate.watchdogWaits,
          attempts: convergenceAttempts,
          tornCount: capture.torn.length,
          mismatches: [...convergenceMismatches],
          detail: `Live raster matches the expected ${mode} resource.`,
        },
        observationId: capture.observation.observationId,
      });
      diagnostics.push(...cycleDiagnostics);
      if (cycleOutcome !== 'PASS') {
        harnessInvalid = evaluation.harnessInvalid;
        outcome = cycleOutcome;
        detail = `Image ${mode} checkpoint ${cycleOutcome}: ${evaluation.checks.map((check) => `${check.checkId}=${check.passed ? 'PASS' : 'FAIL'}`).join(', ')}.`;
        wakeSource = gate.wakeSource;
        fallbackPollCount = gate.fallbackPollCount;
        imageReport = buildImageReport(cycles, input, installed, preflight);
        return finish();
      }

      acceptedUpload = {
        sourceSha256: (raster?.source?.sha256 as string) ?? '',
        rgbaSha256: (raster?.rendered?.rgbaSha256 as string) ?? '',
        probes: Array.isArray((raster?.rendered as { probes?: unknown } | null | undefined)?.probes)
          ? (
              raster?.rendered as {
                probes: readonly { probeId: string; rgba: readonly number[] }[];
              }
            ).probes
          : [],
        snapshot: capture.observation.snapshot.layoutItems,
      };
      wakeSource = gate.wakeSource;
      fallbackPollCount = gate.fallbackPollCount;
    }

    outcome = 'PASS';
    harnessInvalid = false;
    detail = 'Image upload/replace drive passed both checkpoints.';
    imageReport = buildImageReport(cycles, input, installed, preflight);
  } catch (error) {
    environmentInvalid = true;
    diagnostics.push(
      createDiagnostic(
        'RUNTIME_LAUNCH_FAILED',
        `Image drive runtime failed: ${(error as Error).message}`,
      ),
    );
    detail = `Image drive runtime failed: ${(error as Error).message}`;
    imageReport = imageReport ?? null;
  } finally {
    const installed = installedRef.current;
    if (installed !== null) {
      try {
        await installed.unregister();
      } catch (error) {
        environmentInvalid = true;
        diagnostics.push(
          createDiagnostic(
            'CLEANUP_IO_FAILED',
            `Resource route unregister failed: ${(error as Error).message}`,
          ),
        );
      }
    }
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
    if (environmentInvalid) {
      harnessInvalid = true;
      outcome = 'HARNESS_BLOCKED';
    }
  }

  return finish();
}

function buildHarnessCycle(
  mode: 'upload' | 'replacement',
  checkpoint: 'after-upload-current' | 'after-replacement-current',
  diagnostics: readonly DiagnosticRecord[],
  torn: readonly TornObservation[],
  action: { ok: boolean; detail: string; at: string },
  elapsedMs: number,
  gate?: CorrelatedGateResult,
): ImageCycleReport {
  return {
    checkpoint,
    mode,
    outcome: 'HARNESS_BLOCKED',
    requiredChecks: [],
    checks: [],
    harnessInvalid: true,
    observationId: null,
    wakeSource: gate?.wakeSource ?? 'none',
    fallbackPollCount: gate?.fallbackPollCount ?? 0,
    watchdogWaits: gate?.watchdogWaits ?? 0,
    tornCount: torn.length,
    rasterEvaluationCount: 0,
    rasterConvergenceAttempts: 0,
    rasterConvergenceFallbackPollCount: 0,
    quiescenceFrames: 0,
    timings: { totalMs: Math.round(elapsedMs) },
    actionLogs: [],
    diagnostics,
    detail: action.detail,
  };
}

function buildImageReport(
  cycles: readonly ImageCycleReport[],
  input: ExecuteImagePlanInput,
  installed: InstalledResourceRoutes | null,
  preflight: readonly ResourcePreflightFact[],
): ImageDriveReport {
  return {
    cycles,
    resources: input.resources.map((resource) => ({
      logicalId: resource.logicalId,
      version: resource.version,
      filename: resource.filename,
      byteLength: resource.byteLength,
      sha256: resource.sha256,
      mimeType: resource.mimeType,
    })),
    resourceManifestFingerprint: input.resourceManifestFingerprint,
    routeOwnership: (installed?.ownership ?? []).map((entry) => ({
      logicalId: entry.logicalId,
      version: entry.version,
      url: entry.url,
    })),
    requestLog: installed?.log ?? { schemaVersion: 1, records: [] },
    preflight,
  };
}

/**
 * The accepted Image checkpoint facts the executor owns and the final Image
 * payload retains. The payload variant is derived from the single
 * `FinalExecutionPayload` union so this executor imports no adapter/kernel type.
 */
type ImageFinalPayload = Extract<FinalExecutionPayload, { evaluatorKind: 'image-upload-replace' }>;

/**
 * Projects every declared required-authoritative evidence id from the exact
 * compiled profile with its actual availability. `current` primitive authority
 * yields `authoritative`; a malformed authority yields `malformed`. No evidence
 * id is invented and no legacy composite check is read.
 */
function imageEvidenceFacts(
  evidenceIds: readonly string[],
  authority: 'current' | 'malformed',
): ImageFinalPayload['evidence'] {
  const availability = authority === 'current' ? 'authoritative' : 'malformed';
  return evidenceIds.map((evidenceId) => ({ evidenceId, availability }));
}

/**
 * Copies the compiled readiness policy from the exact planning envelope. The
 * envelope is the only authority; a divergent runtime constant would be a
 * contract disagreement, so no runtime profile literal is used here.
 */
function imageReadinessPolicy(
  envelope: MaterializedExecutionEnvelopeV1,
): ImageFinalPayload['readiness']['policy'] {
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

/** Projects one accepted resolved resource into the kernel resource fact shape. */
function imageKernelResourceFact(
  resource: ResolvedResource,
): ImageFinalPayload['expectedResource'] {
  return {
    logicalId: resource.logicalId,
    version: resource.version,
    sha256: resource.sha256,
    byteLength: resource.byteLength,
    mimeType: resource.mimeType,
    dimensions: resource.dimensions,
    probes: resource.structuralVisual.probes.map((probe) => ({
      id: probe.id,
      x: probe.x,
      y: probe.y,
      expectedRgba: probe.expectedRgba,
      channelTolerance: probe.channelTolerance,
    })),
  };
}

/**
 * Builds the existing check-free Image nested-projection header from the cycles
 * the executor actually captured. The façade attaches the evaluated checks.
 */
function buildImageProjectionHeader(
  cycles: readonly ImageCycleReport[],
  actionCycleRef: string,
): ImageProjectionHeader {
  return {
    schemaVersion: FINAL_NESTED_PROJECTION_SCHEMA_VERSION,
    family: 'image',
    cycles: cycles.map((cycle) => ({
      checkpoint: cycle.checkpoint,
      mode: cycle.mode,
      outcome: cycle.outcome,
      observationId: cycle.observationId,
      tornRecaptureCount: cycle.tornCount,
      actionCycleRef,
    })),
  };
}

function readExpectedFrame(
  expected: Readonly<Record<string, unknown>>,
): { x: number; y: number; width: number; height: number; rotation: number } | null {
  const raw = expected.imageFrame;
  if (typeof raw !== 'object' || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const fields = ['x', 'y', 'width', 'height', 'rotation'] as const;
  const values: number[] = [];
  for (const field of fields) {
    const value = record[field];
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    values.push(value);
  }
  return {
    x: values[0] as number,
    y: values[1] as number,
    width: values[2] as number,
    height: values[3] as number,
    rotation: values[4] as number,
  };
}
