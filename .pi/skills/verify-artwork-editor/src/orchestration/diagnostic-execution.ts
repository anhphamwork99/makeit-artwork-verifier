import { evaluateCrosswordLiveChecks } from '../adapters/crossword-live-facts';
import { evaluateHistoryLiveChecks } from '../adapters/history-live-facts';
import { evaluateImageLiveChecks } from '../adapters/image-live-facts';
import { evaluateNestedObjectLiveChecks } from '../adapters/object-live-facts';
import { evaluateRestoreLiveChecks } from '../adapters/restore-live-facts';
import {
  evaluateOrdinaryTextLiveChecks,
  evaluateWarpedTextLiveChecks,
} from '../adapters/text-live-facts';
import {
  createDiagnostic,
  type DiagnosticCode,
  type DiagnosticRecord,
} from '../contracts/diagnostics';
import {
  isCheckEvaluator,
  isOracleEvaluatorKind,
  type ActionCycleCorrectnessIdentity,
  type CheckEvaluator,
  type CorrectnessCheckResult,
  type OracleEvaluatorKind,
  type ResolvedCorrectnessProfile,
} from '../contracts/correctness';
import type { AllocationFailureReason, Capability, Outcome } from '../contracts/discriminants';
import {
  FINAL_NESTED_PROJECTION_SCHEMA_VERSION,
  assembleFinalChildRecordV4,
  type FinalCurrentChildRecordV4,
  type FinalNestedProjectionV4,
} from '../contracts/final-record-v4';
import {
  FINAL_EVALUATOR_DISPATCH as MATERIALIZED_FINAL_EVALUATOR_DISPATCH,
  type MaterializedExecutionEnvelopeV1,
} from '../planner/execution-materialization';
import type { FinalExecutionObservation, FinalExecutionPayload } from '../runtime/execute-plan';
import type { PlanForExecutionResult } from '../planner/plan-case';
import { classifyStatusOutcome } from '../runtime/result-outcome';

/**
 * P7-B2-D1 representative Diagnostic execution orchestration (ADR 0029 §4
 * B2-D; post-cutover current path, ADR 0032 §E3-S2).
 *
 * This is the runtime half of the P7-B2-D checkpoint that backs the current
 * `pnpm verify:artwork diagnostic --case` boundary: it accepts the exact
 * `planCaseForExecution` projection (plan plus compile-once envelope), the
 * prelaunch allocation facts, and one atomic executor-owned final observation,
 * runs the accepted current family adapter/kernel,
 * classifies the three-state required checks with the pure status classifier,
 * and assembles one strict v4 child record.
 *
 * The family path is selected **solely** by the compiled evaluator discriminant
 * and its adapter compatibility version, never by Subject, family name, or
 * scenario. An undelivered binding (`envelope === null`) fails closed before any
 * allocation with `launchAttempted:false`, the trustworthy planned identities,
 * and no child record. An external pre-authority failure fabricates no check. A
 * post-launch delivery with missing authority yields a complete `UNUSABLE`
 * required-check set.
 *
 * This module is the current Diagnostic orchestration: the post-cutover CLI
 * reaches it through the final façade. It owns no policy: no required-check
 * array, no profile/fallback id, no deadline/tolerance/visual/normalization/
 * evidence-role literal, no catalogue access, and no recompilation. It never
 * writes evidence and never calls a legacy boolean/v3 writer.
 */

/** Family route projection handed to the current live-fact adapters. */
export interface FamilyLiveRoute {
  readonly subjectId: string;
  readonly capability: Capability;
  readonly variant: string | null;
}

/** Prelaunch facts: an exclusive reservation, or an external allocation refusal. */
export interface ReservedPrelaunchFacts {
  readonly kind: 'reserved';
  readonly allocationId: string;
  readonly executionInstanceId: string;
}

export interface RefusedPrelaunchFacts {
  readonly kind: 'allocation-failed';
  readonly reason: AllocationFailureReason;
  readonly detail: string;
}

export type DiagnosticPrelaunchFacts = ReservedPrelaunchFacts | RefusedPrelaunchFacts;

/** One compiled evaluator + adapter-compatibility-version dispatch entry. */
export interface FinalEvaluatorDispatchEntry {
  readonly evaluatorKind: OracleEvaluatorKind;
  readonly compatibilityVersion: number;
  /** The check evaluators this family's final kernel may emit. */
  readonly checkEvaluators: readonly CheckEvaluator[];
}

function dispatchEntry(
  evaluatorKind: OracleEvaluatorKind,
  compatibilityVersion: number,
): FinalEvaluatorDispatchEntry {
  return Object.freeze({
    evaluatorKind,
    compatibilityVersion,
    checkEvaluators: MATERIALIZED_FINAL_EVALUATOR_DISPATCH[evaluatorKind],
  });
}

/**
 * Closed dispatch table. Selection is by the compiled evaluator discriminant
 * plus the compiled adapter compatibility version only; there is no Subject,
 * family-name, or scenario branch anywhere in this module. The table has exactly
 * the seven accepted representative families.
 */
export const FINAL_EVALUATOR_DISPATCH: readonly FinalEvaluatorDispatchEntry[] = Object.freeze([
  dispatchEntry('geometry-delta', 3),
  dispatchEntry('warped-text-envelope', 3),
  dispatchEntry('nested-object-affine', 2),
  dispatchEntry('image-upload-replace', 2),
  dispatchEntry('crossword-determinism', 2),
  dispatchEntry('history-cross-subject', 1),
  dispatchEntry('frontend-restore', 1),
]);

/**
 * Resolves the exact family path from the compiled evaluator discriminant and
 * the compiled adapter compatibility version. An unknown discriminant or an
 * unsupported compatibility version resolves to `null` and fails closed; the
 * caller never falls back to a default family.
 */
export function resolveFinalEvaluatorDispatch(
  evaluatorKind: unknown,
  compatibilityVersion: unknown,
): FinalEvaluatorDispatchEntry | null {
  if (!isOracleEvaluatorKind(evaluatorKind)) return null;
  if (typeof compatibilityVersion !== 'number' || !Number.isInteger(compatibilityVersion)) {
    return null;
  }
  return (
    FINAL_EVALUATOR_DISPATCH.find(
      (entry) =>
        entry.evaluatorKind === evaluatorKind &&
        entry.compatibilityVersion === compatibilityVersion,
    ) ?? null
  );
}

/** Closed orchestration issue vocabulary. */
export const DIAGNOSTIC_EXECUTION_ISSUE_CODES = [
  'PLANNING_HARNESS_BLOCKED',
  'PLANNING_ENVIRONMENT_FAILURE',
  'ENVELOPE_UNDELIVERED',
  'DISPATCH_EVALUATOR_UNSUPPORTED',
  'DISPATCH_COMPATIBILITY_VERSION_UNSUPPORTED',
  'DISPATCH_CHECK_EVALUATOR_UNSUPPORTED',
  'OBSERVATION_PAYLOAD_MALFORMED',
  'OBSERVATION_DISCRIMINANT_MISMATCH',
  'OBSERVATION_ENVELOPE_MISMATCH',
  'OBSERVATION_ACTION_CYCLE_MISMATCH',
  'EXTERNAL_PREAUTHORITY_FAILURE',
  'ADAPTER_DISAGREEMENT',
  'KERNEL_PROFILE_UNTRUSTWORTHY',
  'REQUIRED_CHECK_DRIFT',
  'RECORD_ASSEMBLY_FAILED',
] as const;
export type DiagnosticExecutionIssueCode = (typeof DIAGNOSTIC_EXECUTION_ISSUE_CODES)[number];

/** Primary orchestration diagnostic per issue; never a product `BUG` code. */
const PRIMARY_DIAGNOSTIC_CODE: Readonly<Record<DiagnosticExecutionIssueCode, DiagnosticCode>> =
  Object.freeze({
    PLANNING_HARNESS_BLOCKED: 'CORRECTNESS_COMPATIBILITY_DIVERGENCE',
    PLANNING_ENVIRONMENT_FAILURE: 'RUN_RESOURCE_COLLISION',
    ENVELOPE_UNDELIVERED: 'CORRECTNESS_PROFILE_MISSING',
    DISPATCH_EVALUATOR_UNSUPPORTED: 'CORRECTNESS_UNKNOWN_DISCRIMINANT',
    DISPATCH_COMPATIBILITY_VERSION_UNSUPPORTED: 'CORRECTNESS_COMPATIBILITY_DIVERGENCE',
    DISPATCH_CHECK_EVALUATOR_UNSUPPORTED: 'CORRECTNESS_UNKNOWN_DISCRIMINANT',
    OBSERVATION_PAYLOAD_MALFORMED: 'CORRECTNESS_COMPATIBILITY_DIVERGENCE',
    OBSERVATION_DISCRIMINANT_MISMATCH: 'CORRECTNESS_COMPATIBILITY_DIVERGENCE',
    OBSERVATION_ENVELOPE_MISMATCH: 'CORRECTNESS_COMPATIBILITY_DIVERGENCE',
    OBSERVATION_ACTION_CYCLE_MISMATCH: 'CORRECTNESS_COMPATIBILITY_DIVERGENCE',
    EXTERNAL_PREAUTHORITY_FAILURE: 'RUNTIME_LAUNCH_FAILED',
    ADAPTER_DISAGREEMENT: 'CORRECTNESS_COMPATIBILITY_DIVERGENCE',
    KERNEL_PROFILE_UNTRUSTWORTHY: 'CORRECTNESS_COMPATIBILITY_DIVERGENCE',
    REQUIRED_CHECK_DRIFT: 'CORRECTNESS_REFERENCE_UNRESOLVED',
    RECORD_ASSEMBLY_FAILED: 'CORRECTNESS_COMPATIBILITY_DIVERGENCE',
  } satisfies Record<DiagnosticExecutionIssueCode, DiagnosticCode>);

export interface DiagnosticExecutionIssue {
  readonly code: DiagnosticExecutionIssueCode;
  readonly detail: string;
}

export interface DiagnosticExecutionInput {
  /** The exact internal planning projection produced by `planCaseForExecution`. */
  readonly planning: PlanForExecutionResult;
  /** Prelaunch allocation facts, or an external allocation refusal. */
  readonly prelaunch: DiagnosticPrelaunchFacts;
  /** The atomic executor-owned handoff, or null before any family execution. */
  readonly observation: FinalExecutionObservation | null;
  /** Durable attempt identity recorded on the strict v4 child record. */
  readonly runId: string;
  /** Cleanup completion; a failed cleanup converts only the final outcome. */
  readonly cleanupSucceeded: boolean;
  /** External launch/prerequisite failure after a reservation. */
  readonly externalFailure?: boolean;
}

/**
 * The terminal orchestration outcome. `finalOutcome` is one of the four accepted
 * outcomes; `behaviorOutcome` preserves the product behavior verdict
 * independently, and is `null` only when no check authority was evaluated.
 * `record` is the strict v4 child record, or `null` when the case was refused
 * before producing one.
 */
export interface DiagnosticExecutionOutcome {
  readonly finalOutcome: Outcome;
  readonly behaviorOutcome: Outcome | null;
  readonly launchAttempted: boolean;
  readonly prelaunch: boolean;
  readonly caseId: string | null;
  readonly materializationFingerprint: string | null;
  readonly planFingerprint: string | null;
  readonly evaluatorKind: OracleEvaluatorKind | null;
  readonly compatibilityVersion: number | null;
  readonly requiredChecks: readonly CorrectnessCheckResult[];
  readonly unusableCheckIds: readonly string[];
  readonly failingCheckIds: readonly string[];
  readonly record: FinalCurrentChildRecordV4 | null;
  readonly issues: readonly DiagnosticExecutionIssue[];
  readonly diagnostics: readonly DiagnosticRecord[];
}

interface FamilyEvaluationSuccess {
  readonly ok: true;
  readonly checks: readonly CorrectnessCheckResult[];
}

interface FamilyEvaluationFailure {
  readonly ok: false;
  readonly issueCode: DiagnosticExecutionIssueCode;
  readonly code: DiagnosticCode;
  readonly diagnostic: DiagnosticRecord;
  readonly detail: string;
}

type FamilyEvaluation = FamilyEvaluationSuccess | FamilyEvaluationFailure;

interface AdapterFailureView {
  readonly ok: false;
  readonly code: DiagnosticCode;
  readonly diagnostic: DiagnosticRecord;
  readonly issues: readonly { readonly code: string; readonly detail: string }[];
}

function adapterFailure(out: AdapterFailureView): FamilyEvaluationFailure {
  const primary = out.issues[0];
  return {
    ok: false,
    issueCode: 'ADAPTER_DISAGREEMENT',
    code: out.code,
    diagnostic: out.diagnostic,
    detail: primary === undefined ? out.diagnostic.detail : `${primary.code}: ${primary.detail}`,
  };
}

function kernelFailure(detail: string): FamilyEvaluationFailure {
  return {
    ok: false,
    issueCode: 'KERNEL_PROFILE_UNTRUSTWORTHY',
    code: 'CORRECTNESS_COMPATIBILITY_DIVERGENCE',
    diagnostic: createDiagnostic('CORRECTNESS_COMPATIBILITY_DIVERGENCE', detail, {
      context: { issueCode: 'KERNEL_PROFILE_UNTRUSTWORTHY' },
    }),
    detail,
  };
}

/**
 * Runs exactly one family adapter/kernel path selected by the compiled
 * discriminant, or fails closed before the kernel on any adapter disagreement.
 * The adapter owns facts only; every status comes from the accepted kernel.
 */
function evaluateFamilyPath(input: {
  readonly envelope: MaterializedExecutionEnvelopeV1;
  readonly route: FamilyLiveRoute;
  readonly actionCycle: ActionCycleCorrectnessIdentity;
  readonly payload: FinalExecutionPayload;
}): FamilyEvaluation {
  const { envelope, route, actionCycle, payload } = input;
  switch (payload.evaluatorKind) {
    case 'geometry-delta': {
      const out = evaluateOrdinaryTextLiveChecks({
        envelope,
        route,
        actionCycle,
        minimumDelta: payload.minimumDelta,
        delta: payload.delta,
        evidence: payload.evidence,
      });
      if (!out.ok) return adapterFailure(out);
      if (out.result.ok !== true)
        return kernelFailure('The ordinary-Text kernel rejected the compiled profile.');
      return { ok: true, checks: out.result.checks };
    }
    case 'warped-text-envelope': {
      const out = evaluateWarpedTextLiveChecks({
        envelope,
        route,
        actionCycle,
        minimumDelta: payload.minimumDelta,
        oracle: payload.oracle,
        evidence: payload.evidence,
      });
      if (!out.ok) return adapterFailure(out);
      if (out.result.ok !== true)
        return kernelFailure('The warped-Text kernel rejected the compiled profile.');
      return { ok: true, checks: out.result.checks };
    }
    case 'nested-object-affine': {
      const out = evaluateNestedObjectLiveChecks({
        envelope,
        route,
        actionCycle,
        minimumDelta: payload.minimumDelta,
        oracle: payload.oracle,
        evidence: payload.evidence,
      });
      if (!out.ok) return adapterFailure(out);
      if (out.result.ok !== true)
        return kernelFailure('The nested-Object kernel rejected the compiled profile.');
      return { ok: true, checks: out.result.checks };
    }
    case 'image-upload-replace': {
      const out = evaluateImageLiveChecks({
        envelope,
        route,
        actionCycle,
        mode: payload.mode,
        targetId: payload.targetId,
        expectedLayoutId: payload.expectedLayoutId,
        expectedFrame: payload.expectedFrame,
        expectedResource: payload.expectedResource,
        acceptedUpload: payload.acceptedUpload,
        oracle: payload.oracle,
        raster: payload.raster,
        readiness: payload.readiness,
        evidence: payload.evidence,
      });
      if (!out.ok) return adapterFailure(out);
      if (out.result.ok !== true)
        return kernelFailure('The Image kernel rejected the compiled profile.');
      return { ok: true, checks: out.result.checks };
    }
    case 'crossword-determinism': {
      const out = evaluateCrosswordLiveChecks({
        envelope,
        route,
        actionCycle,
        clock: payload.clock,
        sourceFingerprintExpected: payload.sourceFingerprintExpected,
        executions: payload.executions,
        oracle: payload.oracle,
        evidence: payload.evidence,
      });
      if (!out.ok) return adapterFailure(out);
      if (out.result.ok !== true)
        return kernelFailure('The Crossword kernel rejected the compiled profile.');
      return { ok: true, checks: out.result.checks };
    }
    case 'history-cross-subject': {
      const out = evaluateHistoryLiveChecks({
        envelope,
        route,
        actionCycle,
        retainedLayoutId: payload.retainedLayoutId,
        setup: payload.setup,
        actions: payload.actions,
        finalHistory: payload.finalHistory,
        readiness: payload.readiness,
        oracle: payload.oracle,
        evidence: payload.evidence,
      });
      if (!out.ok) return adapterFailure(out);
      if (out.result.ok !== true)
        return kernelFailure('The History kernel rejected the compiled profile.');
      return { ok: true, checks: out.result.checks };
    }
    case 'frontend-restore': {
      const out = evaluateRestoreLiveChecks({
        envelope,
        route,
        actionCycle,
        schemaVersion: payload.schemaVersion,
        transition: payload.transition,
        meaning: payload.meaning,
        rawSemantics: payload.rawSemantics,
        source: payload.source,
        restored: payload.restored,
        setup: payload.setup,
        readiness: payload.readiness,
        oracle: payload.oracle,
        evidence: payload.evidence,
      });
      if (!out.ok) return adapterFailure(out);
      if (out.result.ok !== true)
        return kernelFailure('The Restore kernel rejected the compiled profile.');
      return { ok: true, checks: out.result.checks };
    }
  }
  // Unreachable: the closed union above is exhaustively dispatched.
  return kernelFailure('The compiled evaluator discriminant has no delivered family path.');
}

function actionCycleProjection(
  profile: ResolvedCorrectnessProfile,
  actionCycle: ActionCycleCorrectnessIdentity,
): FinalNestedProjectionV4 {
  return {
    schemaVersion: FINAL_NESTED_PROJECTION_SCHEMA_VERSION,
    family: 'action-cycle',
    actionCycles: [actionCycle],
    readiness: {
      profileId: profile.readiness.profileId,
      timingCategory: profile.readiness.deadlineCategory,
      deadlineMs: profile.readiness.deadlineMs,
      signalWatchdogMs: profile.readiness.signalWatchdogMs,
      stableFrames: profile.readiness.stableFrames,
    },
  };
}

/** Attaches the produced check set to a family projection header. */
function attachFamilyChecks(
  header: Exclude<FinalExecutionPayload['projection'], null>,
  checks: readonly CorrectnessCheckResult[],
): FinalNestedProjectionV4 {
  switch (header.family) {
    case 'image':
      return {
        ...header,
        cycles: header.cycles.map((cycle) => ({ ...cycle, checks })),
      };
    case 'crossword':
      return {
        ...header,
        executions: header.executions.map((execution) => ({ ...execution, checks })),
      };
    case 'history':
    case 'restore':
      return { ...header, checks };
  }
}

function buildNestedProjections(
  profile: ResolvedCorrectnessProfile,
  actionCycle: ActionCycleCorrectnessIdentity,
  checks: readonly CorrectnessCheckResult[],
  header: FinalExecutionPayload['projection'],
): FinalNestedProjectionV4[] {
  const projections: FinalNestedProjectionV4[] = [actionCycleProjection(profile, actionCycle)];
  if (header !== null) projections.push(attachFamilyChecks(header, checks));
  return projections;
}

interface PlannedIdentities {
  readonly caseId: string;
  readonly materializationFingerprint: string;
  readonly planFingerprint: string;
}

function refusal(input: {
  readonly finalOutcome: Outcome;
  readonly launchAttempted: boolean;
  readonly identities: PlannedIdentities | null;
  readonly evaluatorKind?: OracleEvaluatorKind | null;
  readonly compatibilityVersion?: number | null;
  readonly issues: readonly DiagnosticExecutionIssue[];
  readonly diagnostics?: readonly DiagnosticRecord[];
}): DiagnosticExecutionOutcome {
  const primary = input.issues[0];
  const diagnostics =
    input.diagnostics ??
    (primary === undefined
      ? [createDiagnostic('CORRECTNESS_COMPATIBILITY_DIVERGENCE', 'Diagnostic execution refused.')]
      : [
          createDiagnostic(
            PRIMARY_DIAGNOSTIC_CODE[primary.code],
            `${primary.code}: ${primary.detail}`,
            { context: { issueCode: primary.code } },
          ),
        ]);
  return {
    finalOutcome: input.finalOutcome,
    behaviorOutcome: null,
    launchAttempted: input.launchAttempted,
    prelaunch: input.launchAttempted === false,
    caseId: input.identities?.caseId ?? null,
    materializationFingerprint: input.identities?.materializationFingerprint ?? null,
    planFingerprint: input.identities?.planFingerprint ?? null,
    evaluatorKind: input.evaluatorKind ?? null,
    compatibilityVersion: input.compatibilityVersion ?? null,
    requiredChecks: [],
    unusableCheckIds: [],
    failingCheckIds: [],
    record: null,
    issues: Object.freeze([...input.issues]),
    diagnostics: Object.freeze([...diagnostics]),
  };
}

/**
 * Executes one representative Diagnostic case through the current final path.
 *
 * Order is deliberate and fail-closed:
 *  1. a non-`PLANNED` planning projection is passed through with no record;
 *  2. a planned but undelivered binding (`envelope === null`) is a preallocation
 *     `HARNESS_BLOCKED` failure carrying the trustworthy planned identities;
 *  3. the family path is dispatched by compiled evaluator discriminant plus
 *     adapter compatibility version;
 *  4. an external pre-authority failure fabricates no check and leaves the
 *     behavior verdict `null`;
 *  5. otherwise the family adapter/kernel, the pure status classifier, and the
 *     strict v4 assembly run in that order.
 */
export function executeDiagnosticCase(input: DiagnosticExecutionInput): DiagnosticExecutionOutcome {
  const { planning } = input;

  if (planning.status === 'HARNESS_BLOCKED') {
    return refusal({
      finalOutcome: 'HARNESS_BLOCKED',
      launchAttempted: false,
      identities: null,
      issues: [{ code: 'PLANNING_HARNESS_BLOCKED', detail: planning.diagnostic.detail }],
      diagnostics: planning.findings.length > 0 ? planning.findings : [planning.diagnostic],
    });
  }
  if (planning.status === 'ENVIRONMENT_FAILURE') {
    const findings = planning.findings;
    const primary =
      findings[0] ??
      createDiagnostic(
        'RUN_RESOURCE_COLLISION',
        planning.report.rejectionReasons.join('; ') || planning.reason,
      );
    return refusal({
      finalOutcome: 'ENVIRONMENT_FAILURE',
      launchAttempted: false,
      identities: null,
      issues: [{ code: 'PLANNING_ENVIRONMENT_FAILURE', detail: primary.detail }],
      diagnostics: findings.length > 0 ? findings : [primary],
    });
  }

  const identities: PlannedIdentities = {
    caseId: planning.caseId,
    materializationFingerprint: planning.materializationFingerprint,
    planFingerprint: planning.planFingerprint,
  };

  if (planning.envelope === null) {
    return refusal({
      finalOutcome: 'HARNESS_BLOCKED',
      launchAttempted: false,
      identities,
      issues: [
        {
          code: 'ENVELOPE_UNDELIVERED',
          detail:
            'The binding compiled no correctness profile; execution fails closed before allocation with the trustworthy planned identities and no child record.',
        },
      ],
    });
  }

  const envelope = planning.envelope;
  const profile = envelope.correctnessProfile as unknown as ResolvedCorrectnessProfile;
  const compatibilityVersion = envelope.plan.route.adapterCompatibilityVersion;

  const dispatch = resolveFinalEvaluatorDispatch(
    profile.oracle.evaluatorKind,
    compatibilityVersion,
  );
  if (dispatch === null) {
    const unsupportedKind = !isOracleEvaluatorKind(profile.oracle.evaluatorKind);
    return refusal({
      finalOutcome: 'HARNESS_BLOCKED',
      launchAttempted: false,
      identities,
      evaluatorKind: isOracleEvaluatorKind(profile.oracle.evaluatorKind)
        ? profile.oracle.evaluatorKind
        : null,
      compatibilityVersion: typeof compatibilityVersion === 'number' ? compatibilityVersion : null,
      issues: [
        unsupportedKind
          ? {
              code: 'DISPATCH_EVALUATOR_UNSUPPORTED',
              detail: `Compiled Oracle evaluator "${String(profile.oracle.evaluatorKind)}" has no delivered family dispatch.`,
            }
          : {
              code: 'DISPATCH_COMPATIBILITY_VERSION_UNSUPPORTED',
              detail: `Compiled evaluator "${String(profile.oracle.evaluatorKind)}" at adapter compatibility version ${String(compatibilityVersion)} has no delivered family dispatch.`,
            },
      ],
    });
  }

  for (const contract of profile.requiredChecks) {
    if (
      !isCheckEvaluator(contract.evaluator) ||
      !dispatch.checkEvaluators.includes(contract.evaluator)
    ) {
      return refusal({
        finalOutcome: 'HARNESS_BLOCKED',
        launchAttempted: false,
        identities,
        evaluatorKind: dispatch.evaluatorKind,
        compatibilityVersion: dispatch.compatibilityVersion,
        issues: [
          {
            code: 'DISPATCH_CHECK_EVALUATOR_UNSUPPORTED',
            detail: `Required check "${contract.checkId}" declares evaluator "${String(contract.evaluator)}" which the "${dispatch.evaluatorKind}" family does not dispatch.`,
          },
        ],
      });
    }
  }

  const launchAttempted = input.prelaunch.kind === 'reserved';
  if (input.prelaunch.kind !== 'reserved' || input.externalFailure === true) {
    // External pre-authority failure: no adapter, no fabricated checks, and no
    // child record. The behavior verdict stays `null` because nothing was
    // evaluated; only the final outcome becomes `ENVIRONMENT_FAILURE`.
    const classification = classifyStatusOutcome({
      requiredChecks: [],
      cleanupSucceeded: input.cleanupSucceeded,
      externalFailure: true,
    });
    const detail =
      input.prelaunch.kind === 'allocation-failed'
        ? `Allocation refused before launch: ${input.prelaunch.reason} (${input.prelaunch.detail}).`
        : 'An external launch/prerequisite failure prevented any trustworthy evaluation.';
    return {
      finalOutcome: classification.finalOutcome,
      behaviorOutcome: classification.behaviorOutcome,
      launchAttempted: false,
      prelaunch: true,
      caseId: identities.caseId,
      materializationFingerprint: identities.materializationFingerprint,
      planFingerprint: identities.planFingerprint,
      evaluatorKind: dispatch.evaluatorKind,
      compatibilityVersion: dispatch.compatibilityVersion,
      requiredChecks: [],
      unusableCheckIds: [],
      failingCheckIds: [],
      record: null,
      issues: Object.freeze([
        { code: 'EXTERNAL_PREAUTHORITY_FAILURE', detail } satisfies DiagnosticExecutionIssue,
      ]),
      diagnostics: Object.freeze([
        createDiagnostic('RUNTIME_LAUNCH_FAILED', detail, {
          context: { issueCode: 'EXTERNAL_PREAUTHORITY_FAILURE' },
        }),
      ]),
    };
  }

  const observation = input.observation;
  if (observation === null) {
    return refusal({
      finalOutcome: 'HARNESS_BLOCKED',
      launchAttempted,
      identities,
      evaluatorKind: dispatch.evaluatorKind,
      compatibilityVersion: dispatch.compatibilityVersion,
      issues: [
        {
          code: 'OBSERVATION_PAYLOAD_MALFORMED',
          detail: 'The executor did not return an atomic final observation after launch.',
        },
      ],
    });
  }
  if (observation.envelope !== envelope) {
    return refusal({
      finalOutcome: 'HARNESS_BLOCKED',
      launchAttempted,
      identities,
      evaluatorKind: dispatch.evaluatorKind,
      compatibilityVersion: dispatch.compatibilityVersion,
      issues: [
        {
          code: 'OBSERVATION_ENVELOPE_MISMATCH',
          detail:
            'The executor final observation does not retain the exact planning envelope reference.',
        },
      ],
    });
  }
  if (
    observation.actionCycle.resolvedProfileFingerprint !==
      envelope.correctnessProfile.resolvedFingerprint ||
    observation.actionCycle.readinessFingerprint !==
      envelope.correctnessProfile.componentFingerprints.readiness
  ) {
    return refusal({
      finalOutcome: 'HARNESS_BLOCKED',
      launchAttempted,
      identities,
      evaluatorKind: dispatch.evaluatorKind,
      compatibilityVersion: dispatch.compatibilityVersion,
      issues: [
        {
          code: 'OBSERVATION_ACTION_CYCLE_MISMATCH',
          detail:
            'The executor Action Cycle identity does not agree with the exact planning envelope fingerprints.',
        },
      ],
    });
  }
  if (observation.payload.evaluatorKind !== dispatch.evaluatorKind) {
    return refusal({
      finalOutcome: 'HARNESS_BLOCKED',
      launchAttempted,
      identities,
      evaluatorKind: dispatch.evaluatorKind,
      compatibilityVersion: dispatch.compatibilityVersion,
      issues: [
        {
          code: 'OBSERVATION_DISCRIMINANT_MISMATCH',
          detail: `The delivered observation declares evaluator "${String(observation.payload.evaluatorKind)}" but the compiled profile dispatches "${dispatch.evaluatorKind}".`,
        },
      ],
    });
  }

  const intent = planning.materializedCase.intent;
  const route: FamilyLiveRoute = {
    subjectId: intent.subjectId,
    capability: intent.capability,
    variant: intent.variant,
  };

  const evaluated = evaluateFamilyPath({
    envelope,
    route,
    actionCycle: observation.actionCycle,
    payload: observation.payload,
  });
  if (!evaluated.ok) {
    return refusal({
      finalOutcome: 'HARNESS_BLOCKED',
      launchAttempted,
      identities,
      evaluatorKind: dispatch.evaluatorKind,
      compatibilityVersion: dispatch.compatibilityVersion,
      issues: [{ code: evaluated.issueCode, detail: evaluated.detail }],
      diagnostics: [evaluated.diagnostic],
    });
  }

  const checks = evaluated.checks;
  const declared = [...profile.requiredChecks.map((contract) => contract.checkId)].sort();
  const produced = [...checks.map((check) => check.checkId)].sort();
  if (declared.length !== produced.length || declared.some((id, index) => id !== produced[index])) {
    return refusal({
      finalOutcome: 'HARNESS_BLOCKED',
      launchAttempted,
      identities,
      evaluatorKind: dispatch.evaluatorKind,
      compatibilityVersion: dispatch.compatibilityVersion,
      issues: [
        {
          code: 'REQUIRED_CHECK_DRIFT',
          detail: `The evaluated check set [${produced.join(', ')}] does not equal the compiled required-check set [${declared.join(', ')}].`,
        },
      ],
    });
  }

  // `externalFailure === true` was already answered by the pre-authority refusal
  // above, so only cleanup completion can still convert the final outcome.
  const classification = classifyStatusOutcome({
    requiredChecks: checks,
    cleanupSucceeded: input.cleanupSucceeded,
  });

  const assembled = assembleFinalChildRecordV4({
    envelope,
    runId: input.runId,
    observationId: observation.observationId,
    actionCycles: [observation.actionCycle],
    requiredChecks: checks,
    nestedProjections: buildNestedProjections(
      profile,
      observation.actionCycle,
      checks,
      observation.payload.projection,
    ),
  });

  if (!assembled.ok) {
    const primary = assembled.issues[0];
    return refusal({
      finalOutcome: 'HARNESS_BLOCKED',
      launchAttempted,
      identities,
      evaluatorKind: dispatch.evaluatorKind,
      compatibilityVersion: dispatch.compatibilityVersion,
      issues: [
        {
          code: 'RECORD_ASSEMBLY_FAILED',
          detail:
            primary === undefined
              ? 'Strict v4 assembly failed.'
              : `${primary.code}: ${primary.detail}`,
        },
      ],
      diagnostics: [assembled.diagnostic],
    });
  }

  return {
    finalOutcome: classification.finalOutcome,
    behaviorOutcome: classification.behaviorOutcome,
    launchAttempted,
    prelaunch: false,
    caseId: identities.caseId,
    materializationFingerprint: identities.materializationFingerprint,
    planFingerprint: identities.planFingerprint,
    evaluatorKind: dispatch.evaluatorKind,
    compatibilityVersion: dispatch.compatibilityVersion,
    requiredChecks: checks,
    unusableCheckIds: classification.unusableCheckIds,
    failingCheckIds: classification.failingCheckIds,
    record: assembled.record,
    issues: Object.freeze([]),
    diagnostics: Object.freeze([]),
  };
}
