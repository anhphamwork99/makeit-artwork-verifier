import { deriveResolvedCorrectnessProfileFingerprint } from '../catalogue/correctness';
import { derivePlanFingerprint } from '../canonical/identity';
import {
  isFullCanonicalFingerprint,
  type ActionCycleCorrectnessIdentity,
  type ResolvedCorrectnessProfile,
} from '../contracts/correctness';
import {
  createDiagnostic,
  type DiagnosticCode,
  type DiagnosticRecord,
} from '../contracts/diagnostics';
import type { Capability } from '../contracts/discriminants';
import { isPlainRecord } from '../contracts/result-agreement';
import { RESOLVED_CORRECTNESS_PROFILE_SCHEMA_VERSION } from '../contracts/schema-versions';
import {
  HISTORY_KERNEL_CHECK_EVALUATORS,
  HISTORY_KERNEL_EVALUATOR,
  historyCurrentnessForAuthority,
  evaluateHistoryChecks,
  isHistoryEvidenceAvailability,
  type HistoryAuthorityState,
  type HistoryEvaluatorFact,
  type HistoryEvidenceFact,
  type HistoryKernelFacts,
  type HistoryKernelResult,
  type HistoryKernelTupleView,
  type HistoryOracleFactsView,
  type HistoryReadinessFact,
} from '../kernels/history-kernel';
import {
  MATERIALIZED_EXECUTION_ENVELOPE_SCHEMA_VERSION,
  type MaterializedExecutionEnvelopeV1,
} from '../planner/execution-materialization';

/**
 * P7-B2-B5 inactive live-fact adapter for cross-subject History (ADR 0029 §4
 * B2-B, the History half; B2-B5's restore half is a separate port).
 *
 * The adapter sits between the delivered live whole-document History Action
 * Cycle chain and the accepted inactive History kernel. It receives exactly the
 * things the delivered History Action Cycle chain already produced:
 *
 *  1. the exact `MaterializedExecutionEnvelopeV1` compiled once during planning;
 *  2. the route identity (Subject/Capability/variant) of the planned case;
 *  3. the Action Cycle correctness identity that observed the chain;
 *  4. the delivered raw whole-document execution chain — the retained Layout
 *     target, the raw `H0`…`H3` setup checkpoints, the raw six ordered
 *     Undo/Redo transitions, and the raw final tuple — validated by the kernel
 *     through the accepted history observation contract;
 *  5. the accepted readiness policy and observation the chain obeyed;
 *  6. the live History Oracle additive primitive facts and diagnostics; and
 *  7. the observed evidence roles for the chain.
 *
 * It returns the structured kernel fact input for `evaluateHistoryChecks`, or
 * fails closed *before* the kernel when the exact envelope, route, Action Cycle,
 * or observation is not in agreement.
 *
 * The adapter provides **facts only**. It owns no required-check array, no
 * profile id or fallback id, no deadline/tolerance/visual/normalization literal,
 * no tuple/meaning/transition policy, no evidence-role default, no
 * authoring-catalogue access, and no Subject/family/scenario branch. It
 * deliberately does not import any active executor, Oracle, CLI, browser,
 * writer, classifier, or catalogue module: the live observations are consumed
 * through structural contracts that the delivered Oracle evaluation already
 * satisfies. The delivered Oracle's legacy composite check-result booleans and
 * its aggregate harness-validity flag are never read: every structured
 * authority/currentness/chain-agreement/mismatch fact is derived only from the
 * Oracle's additive, explicitly named primitive facts (the raw `H0`…`H3`
 * checkpoints, the ordered transitions with their native control/revision/
 * epoch/idle/torn facts, the retained target, the pre-action chain primitive,
 * and one explicit per-check predicate), and no boolean check result is
 * translated into a final status here.
 *
 * The module is entirely inactive: it is not re-exported from `src/index.ts` and
 * is referenced only by its focused foundation tests.
 */

/** Closed adapter issue vocabulary; deliberately local to the inactive adapter. */
export const HISTORY_LIVE_FACT_ISSUE_CODES = [
  'ENVELOPE_NOT_OBJECT',
  'ENVELOPE_SCHEMA_UNSUPPORTED',
  'ENVELOPE_PLAN_FINGERPRINT_INVALID',
  'ENVELOPE_PLAN_FINGERPRINT_MISMATCH',
  'ENVELOPE_CASE_ID_MISMATCH',
  'ENVELOPE_MATERIALIZATION_FINGERPRINT_INVALID',
  'ENVELOPE_PROFILE_MISSING',
  'ENVELOPE_PROFILE_SCHEMA_UNSUPPORTED',
  'ENVELOPE_PROFILE_FINGERPRINT_INVALID',
  'ENVELOPE_PROFILE_FINGERPRINT_MISMATCH',
  'ENVELOPE_PROFILE_AGREEMENT_MISMATCH',
  'ENVELOPE_COMPONENT_FINGERPRINT_INVALID',
  'ENVELOPE_ROUTE_MISMATCH',
  'ENVELOPE_ORACLE_EVALUATOR_UNSUPPORTED',
  'ENVELOPE_CHECK_EVALUATOR_UNSUPPORTED',
  'ENVELOPE_REQUIRED_CHECK_DRIFT',
  'ENVELOPE_ACTION_CYCLE_MISMATCH',
  'ENVELOPE_READINESS_MISMATCH',
  'HISTORY_LIVE_OBSERVATION_MALFORMED',
  'HISTORY_LIVE_EVIDENCE_FACT_INVALID',
] as const;
export type HistoryLiveFactIssueCode = (typeof HISTORY_LIVE_FACT_ISSUE_CODES)[number];

const PRIMARY_DIAGNOSTIC_CODE: Readonly<Record<HistoryLiveFactIssueCode, DiagnosticCode>> =
  Object.freeze({
    ENVELOPE_NOT_OBJECT: 'CORRECTNESS_COMPATIBILITY_DIVERGENCE',
    ENVELOPE_SCHEMA_UNSUPPORTED: 'CORRECTNESS_CATALOGUE_SCHEMA_UNSUPPORTED',
    ENVELOPE_PLAN_FINGERPRINT_INVALID: 'CORRECTNESS_COMPATIBILITY_DIVERGENCE',
    ENVELOPE_PLAN_FINGERPRINT_MISMATCH: 'CORRECTNESS_COMPATIBILITY_DIVERGENCE',
    ENVELOPE_CASE_ID_MISMATCH: 'CORRECTNESS_COMPATIBILITY_DIVERGENCE',
    ENVELOPE_MATERIALIZATION_FINGERPRINT_INVALID: 'CORRECTNESS_COMPATIBILITY_DIVERGENCE',
    ENVELOPE_PROFILE_MISSING: 'CORRECTNESS_PROFILE_MISSING',
    ENVELOPE_PROFILE_SCHEMA_UNSUPPORTED: 'CORRECTNESS_CATALOGUE_SCHEMA_UNSUPPORTED',
    ENVELOPE_PROFILE_FINGERPRINT_INVALID: 'CORRECTNESS_COMPATIBILITY_DIVERGENCE',
    ENVELOPE_PROFILE_FINGERPRINT_MISMATCH: 'CORRECTNESS_COMPATIBILITY_DIVERGENCE',
    ENVELOPE_PROFILE_AGREEMENT_MISMATCH: 'CORRECTNESS_COMPATIBILITY_DIVERGENCE',
    ENVELOPE_COMPONENT_FINGERPRINT_INVALID: 'CORRECTNESS_COMPATIBILITY_DIVERGENCE',
    ENVELOPE_ROUTE_MISMATCH: 'CORRECTNESS_REFERENCE_AMBIGUOUS',
    ENVELOPE_ORACLE_EVALUATOR_UNSUPPORTED: 'CORRECTNESS_UNKNOWN_DISCRIMINANT',
    ENVELOPE_CHECK_EVALUATOR_UNSUPPORTED: 'CORRECTNESS_UNKNOWN_DISCRIMINANT',
    ENVELOPE_REQUIRED_CHECK_DRIFT: 'CORRECTNESS_REFERENCE_UNRESOLVED',
    ENVELOPE_ACTION_CYCLE_MISMATCH: 'CORRECTNESS_COMPATIBILITY_DIVERGENCE',
    ENVELOPE_READINESS_MISMATCH: 'CORRECTNESS_COMPATIBILITY_DIVERGENCE',
    HISTORY_LIVE_OBSERVATION_MALFORMED: 'UNUSABLE_EVIDENCE',
    HISTORY_LIVE_EVIDENCE_FACT_INVALID: 'UNUSABLE_EVIDENCE',
  } satisfies Record<HistoryLiveFactIssueCode, DiagnosticCode>);

export interface HistoryLiveFactIssue {
  readonly code: HistoryLiveFactIssueCode;
  readonly detail: string;
}

export interface HistoryLiveFactFailure {
  readonly ok: false;
  readonly status: 'HARNESS_BLOCKED';
  readonly launchAttempted: false;
  readonly code: DiagnosticCode;
  readonly diagnostic: DiagnosticRecord;
  readonly issues: readonly HistoryLiveFactIssue[];
}

export type HistoryLiveFactAdaptation<Facts> =
  | { readonly ok: true; readonly facts: Facts }
  | HistoryLiveFactFailure;

/** The route identity a planned case asked the adapter to evaluate. */
export interface HistoryLiveFactRoute {
  readonly subjectId: string;
  readonly capability: Capability;
  readonly variant: string | null;
}

/** One admitted evidence fact; the adapter never invents a role. */
export type HistoryLiveEvidenceFact = HistoryEvidenceFact;

/** Closed explicit authority vocabulary of the additive primitive facts. */
export const HISTORY_LIVE_PRIMITIVE_AUTHORITIES = ['current', 'malformed'] as const;
export type HistoryLivePrimitiveAuthority = (typeof HISTORY_LIVE_PRIMITIVE_AUTHORITIES)[number];

function isLivePrimitiveAuthority(value: unknown): value is HistoryLivePrimitiveAuthority {
  return (
    typeof value === 'string' &&
    (HISTORY_LIVE_PRIMITIVE_AUTHORITIES as readonly string[]).includes(value)
  );
}

/**
 * One explicit per-check primitive predicate of the delivered History Oracle
 * evaluation. `predicateMet` is the Oracle's own per-check predicate derived
 * from the raw whole-document chain and the delivered meaning facts; it is not
 * a legacy composite check-result boolean.
 */
export interface HistoryLivePrimitiveCheckObservation {
  readonly checkId: string;
  readonly predicateMet: boolean;
}

/** Raw accepted `H0`…`H3` setup checkpoint primitive. */
export interface HistoryLivePrimitiveSetupObservation {
  readonly checkpointId: string;
  readonly role: string;
  readonly meaning: string;
  readonly pastDepth: number;
  readonly futureDepth: number;
  readonly baselineClean: boolean;
  readonly meaningFingerprint: string;
}

/**
 * One raw ordered transition primitive with its native control identity, armed
 * and post-action revisions, delivered Action Cycle epoch binding, post-action
 * idle observation, torn-recapture count, pre-action/post-action tuples, and
 * the delivered meaning facts.
 */
export interface HistoryLivePrimitiveTransitionObservation {
  readonly order: number;
  readonly stepIndex: number;
  readonly stepId: string;
  readonly control: string;
  readonly controlAccessibleName: string;
  readonly controlTitle: string;
  readonly controlNativeTag: string;
  readonly controlButtonType: string | null;
  readonly controlVisible: boolean;
  readonly controlEnabledBeforeDispatch: boolean;
  readonly dispatchCount: number;
  readonly actionEpochId: string | null;
  readonly observationId: string | null;
  readonly preActionRevision: number;
  readonly postActionRevision: number;
  readonly revisionAdvanced: boolean;
  readonly idle: {
    readonly stableFrames: number;
    readonly waitedMs: number;
    readonly observationRevision: number;
  } | null;
  readonly historyBefore: HistoryKernelTupleView;
  readonly historyAfter: HistoryKernelTupleView;
  readonly expectedHistory: HistoryKernelTupleView;
  readonly historyTupleExact: boolean;
  readonly expectedMeaning: string;
  readonly meaningFingerprint: string | null;
  readonly expectedMeaningFingerprint: string | null;
  readonly meaningStructurallyEqual: boolean;
  readonly transitionObserved: boolean;
  readonly tornRecaptureCount: number;
}

/**
 * The additive primitive facts of the delivered History Oracle evaluation the
 * adapter is allowed to read (ADR 0029 §4 B2-B): an explicit structured
 * authority, the retained whole-document target, the raw `H0`…`H3` setup
 * checkpoints, the raw ordered transition chain, the final tuple, the raw
 * pre-action chain-correlation primitive, and one explicit per-check predicate.
 * The delivered Oracle's legacy composite check-result booleans and its
 * aggregate harness-validity flag are deliberately not part of this view.
 */
export interface HistoryLivePrimitiveFactsObservation {
  readonly authority: HistoryLivePrimitiveAuthority;
  readonly retainedLayoutId: string | null;
  readonly setup: readonly HistoryLivePrimitiveSetupObservation[] | null;
  readonly transitions: readonly HistoryLivePrimitiveTransitionObservation[] | null;
  readonly finalHistory: HistoryKernelTupleView | null;
  readonly preActionChainCorrelates: boolean;
  readonly checks: readonly HistoryLivePrimitiveCheckObservation[];
}

/**
 * Structural projection of the delivered History Oracle evaluation
 * (`HistoryOracleEvaluation`). The additive `primitiveFacts` view and the raw
 * diagnostics are carried; the legacy aggregate harness-validity flag and
 * per-check boolean check results are not.
 */
export interface HistoryLiveEvaluationObservation {
  readonly primitiveFacts: HistoryLivePrimitiveFactsObservation;
  readonly diagnostics?: readonly { readonly code: string; readonly detail: string }[];
}

export interface HistoryLiveFactAdapterInput {
  readonly envelope: MaterializedExecutionEnvelopeV1;
  readonly route: HistoryLiveFactRoute;
  readonly actionCycle: ActionCycleCorrectnessIdentity;
  /** The delivered retained whole-document Layout target. */
  readonly retainedLayoutId: string | null;
  /** The delivered raw `H0`…`H3` setup checkpoints; validated by the kernel. */
  readonly setup: readonly unknown[];
  /** The delivered raw six ordered transitions; validated by the kernel. */
  readonly actions: readonly unknown[];
  /** The delivered raw final tuple; validated by the kernel. */
  readonly finalHistory: unknown;
  /** The accepted readiness policy and observation; validated by the kernel. */
  readonly readiness: unknown;
  /** The accepted History Oracle evaluation, or `null` when it never ran. */
  readonly oracle: HistoryLiveEvaluationObservation | null;
  /** The observed evidence roles; the adapter never invents a role. */
  readonly evidence: readonly HistoryLiveEvidenceFact[];
}

interface FamilyContract {
  readonly oracleEvaluatorKind: string;
  readonly checkEvaluators: readonly string[];
}

const HISTORY_FAMILY: FamilyContract = Object.freeze({
  oracleEvaluatorKind: HISTORY_KERNEL_EVALUATOR,
  checkEvaluators: HISTORY_KERNEL_CHECK_EVALUATORS,
});

function failure(issues: readonly HistoryLiveFactIssue[]): HistoryLiveFactFailure {
  const primary = issues[0] as HistoryLiveFactIssue;
  const code = PRIMARY_DIAGNOSTIC_CODE[primary.code];
  const diagnostic = createDiagnostic(code, `${primary.code}: ${primary.detail}`, {
    context: { issueCode: primary.code },
  });
  return {
    ok: false,
    status: 'HARNESS_BLOCKED',
    launchAttempted: false,
    code,
    diagnostic,
    issues: Object.freeze([...issues]),
  };
}

function isEvidenceFactArray(value: unknown): value is readonly HistoryEvidenceFact[] {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        isPlainRecord(entry) &&
        typeof entry.evidenceId === 'string' &&
        isHistoryEvidenceAvailability(entry.availability),
    )
  );
}

interface EnvelopeAgreement {
  readonly profile: ResolvedCorrectnessProfile;
}

/**
 * Focused pre-kernel agreement validation of the exact envelope (ADR 0029 §3).
 *
 * It re-derives the plan fingerprint, the resolved-profile fingerprint, the
 * route agreement, the Action Cycle linkage, the evaluator/check discriminants,
 * and the required-check set **from the envelope content alone**. Any failure
 * returns a fail-closed `HARNESS_BLOCKED` result with `launchAttempted:false`,
 * so the kernel is never invoked on a disagreeing envelope. It performs no
 * catalogue, disk, or global-cache lookup and fabricates no profile.
 */
function validateEnvelope(input: {
  envelope: MaterializedExecutionEnvelopeV1;
  route: HistoryLiveFactRoute;
  actionCycle: ActionCycleCorrectnessIdentity;
  family: FamilyContract;
}): EnvelopeAgreement | HistoryLiveFactFailure {
  const issues: HistoryLiveFactIssue[] = [];
  const report = (code: HistoryLiveFactIssueCode, detail: string): void => {
    issues.push({ code, detail });
  };

  const envelope = input.envelope as unknown as Record<string, unknown>;
  if (!isPlainRecord(envelope)) {
    report('ENVELOPE_NOT_OBJECT', 'An execution envelope must be a plain object.');
    return failure(issues);
  }
  if (envelope.schemaVersion !== MATERIALIZED_EXECUTION_ENVELOPE_SCHEMA_VERSION) {
    report(
      'ENVELOPE_SCHEMA_UNSUPPORTED',
      `Execution envelope schema ${String(envelope.schemaVersion)} is not supported.`,
    );
  }
  if (!isFullCanonicalFingerprint(envelope.planFingerprint)) {
    report(
      'ENVELOPE_PLAN_FINGERPRINT_INVALID',
      `Envelope plan fingerprint "${String(envelope.planFingerprint)}" is not a full canonical 64-hex identity.`,
    );
  }
  if (!isFullCanonicalFingerprint(envelope.materializationFingerprint)) {
    report(
      'ENVELOPE_MATERIALIZATION_FINGERPRINT_INVALID',
      `Envelope materialization fingerprint "${String(envelope.materializationFingerprint)}" is not a full canonical 64-hex identity.`,
    );
  }

  const plan = envelope.plan;
  if (!isPlainRecord(plan)) {
    report('ENVELOPE_PLAN_FINGERPRINT_INVALID', 'The envelope carries no readable public plan.');
  } else {
    try {
      const recomputedPlanFingerprint = derivePlanFingerprint(
        plan as unknown as Parameters<typeof derivePlanFingerprint>[0],
      );
      if (recomputedPlanFingerprint !== envelope.planFingerprint) {
        report(
          'ENVELOPE_PLAN_FINGERPRINT_MISMATCH',
          `Recomputed plan fingerprint ${recomputedPlanFingerprint} does not equal the envelope plan fingerprint ${String(envelope.planFingerprint)}.`,
        );
      }
    } catch (error) {
      report(
        'ENVELOPE_PLAN_FINGERPRINT_INVALID',
        `The plan is not canonically fingerprintable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (plan.caseId !== envelope.caseId) {
      report(
        'ENVELOPE_CASE_ID_MISMATCH',
        `Plan case id ${String(plan.caseId)} does not equal the envelope case id ${String(envelope.caseId)}.`,
      );
    }
  }

  const profile = envelope.correctnessProfile;
  if (!isPlainRecord(profile)) {
    report('ENVELOPE_PROFILE_MISSING', 'The envelope carries no readable resolved profile.');
    return failure(issues);
  }
  const profileView = profile as unknown as ResolvedCorrectnessProfile;
  if (profileView.schemaVersion !== RESOLVED_CORRECTNESS_PROFILE_SCHEMA_VERSION) {
    report(
      'ENVELOPE_PROFILE_SCHEMA_UNSUPPORTED',
      `Resolved-profile schema ${String(profileView.schemaVersion)} is not supported.`,
    );
  }
  const storedFingerprint = profileView.resolvedFingerprint;
  if (!isFullCanonicalFingerprint(storedFingerprint)) {
    report(
      'ENVELOPE_PROFILE_FINGERPRINT_INVALID',
      `Resolved-profile fingerprint "${String(storedFingerprint)}" is not a full canonical 64-hex identity.`,
    );
  } else {
    const { resolvedFingerprint: _stored, ...content } = profileView;
    try {
      const recomputed = deriveResolvedCorrectnessProfileFingerprint(
        content as unknown as Omit<ResolvedCorrectnessProfile, 'resolvedFingerprint'>,
      );
      if (recomputed !== storedFingerprint) {
        report(
          'ENVELOPE_PROFILE_FINGERPRINT_MISMATCH',
          `Recomputed resolved-profile fingerprint ${recomputed} does not equal the stored fingerprint ${storedFingerprint}; a compiled field was mutated.`,
        );
      }
    } catch (error) {
      report(
        'ENVELOPE_PROFILE_FINGERPRINT_INVALID',
        `The resolved profile is not canonically fingerprintable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  const components = profileView.componentFingerprints;
  if (!isPlainRecord(components)) {
    report(
      'ENVELOPE_COMPONENT_FINGERPRINT_INVALID',
      'The compiled profile carries no component fingerprints.',
    );
  } else {
    for (const field of [
      'readiness',
      'capture',
      'oracle',
      'capabilityBaseline',
      'subjectAddition',
      'requiredCheckSet',
      'tolerances',
      'visuals',
      'normalization',
    ] as const) {
      if (!isFullCanonicalFingerprint(components[field])) {
        report(
          'ENVELOPE_COMPONENT_FINGERPRINT_INVALID',
          `Compiled component fingerprint "${field}" is not a full canonical 64-hex identity.`,
        );
      }
    }
  }

  // Plan/profile correctness identity agreement.
  const planCorrectness: unknown = isPlainRecord(plan) ? plan.correctness : null;
  if (!isPlainRecord(planCorrectness)) {
    report(
      'ENVELOPE_PROFILE_AGREEMENT_MISMATCH',
      'The plan carries no readable correctness projection identity.',
    );
  } else {
    if (planCorrectness.resolvedFingerprint !== storedFingerprint) {
      report(
        'ENVELOPE_PROFILE_AGREEMENT_MISMATCH',
        `Plan correctness fingerprint ${String(planCorrectness.resolvedFingerprint)} does not equal the resolved-profile fingerprint ${String(storedFingerprint)}.`,
      );
    }
    if (planCorrectness.profileId !== profileView.profileId) {
      report(
        'ENVELOPE_PROFILE_AGREEMENT_MISMATCH',
        `Plan correctness profile id ${String(planCorrectness.profileId)} does not equal the resolved-profile id ${String(profileView.profileId)}.`,
      );
    }
  }

  // Route agreement: the exact planned route the adapter was asked to evaluate.
  const routeMismatches: string[] = [];
  if (profileView.subjectId !== input.route.subjectId) {
    routeMismatches.push(
      `profile subject ${String(profileView.subjectId)} ≠ requested ${input.route.subjectId}`,
    );
  }
  if (profileView.capability !== input.route.capability) {
    routeMismatches.push(
      `profile capability ${String(profileView.capability)} ≠ requested ${String(input.route.capability)}`,
    );
  }
  if (profileView.variant !== input.route.variant) {
    routeMismatches.push(
      `profile variant ${String(profileView.variant)} ≠ requested ${String(input.route.variant)}`,
    );
  }
  if (routeMismatches.length > 0) {
    report('ENVELOPE_ROUTE_MISMATCH', routeMismatches.join('; '));
  }

  // Oracle evaluator discriminant and per-check evaluators.
  const oracle: unknown = profileView.oracle;
  const oracleKind = isPlainRecord(oracle) ? oracle.evaluatorKind : undefined;
  if (oracleKind !== input.family.oracleEvaluatorKind) {
    report(
      'ENVELOPE_ORACLE_EVALUATOR_UNSUPPORTED',
      `Compiled Oracle evaluator "${String(oracleKind)}" is not supported by this History adapter (expected "${input.family.oracleEvaluatorKind}").`,
    );
  }
  const requiredChecks = Array.isArray(profileView.requiredChecks)
    ? profileView.requiredChecks
    : [];
  if (requiredChecks.length === 0) {
    report(
      'ENVELOPE_REQUIRED_CHECK_DRIFT',
      'A compiled profile with no declared required check cannot be adapted.',
    );
  }
  const seen = new Set<string>();
  for (const contract of requiredChecks) {
    const checkId = typeof contract.checkId === 'string' ? contract.checkId : '';
    if (checkId.length === 0) {
      report('ENVELOPE_REQUIRED_CHECK_DRIFT', 'A declared required check has no check id.');
      continue;
    }
    if (seen.has(checkId)) {
      report(
        'ENVELOPE_REQUIRED_CHECK_DRIFT',
        `Declared required check "${checkId}" appears more than once.`,
      );
      continue;
    }
    seen.add(checkId);
    if (
      typeof contract.evaluator !== 'string' ||
      !input.family.checkEvaluators.includes(contract.evaluator)
    ) {
      report(
        'ENVELOPE_CHECK_EVALUATOR_UNSUPPORTED',
        `Required check "${checkId}" declares evaluator "${String(contract.evaluator)}" which this History adapter does not support.`,
      );
    }
  }

  // Action Cycle linkage.
  if (input.actionCycle.resolvedProfileFingerprint !== storedFingerprint) {
    report(
      'ENVELOPE_ACTION_CYCLE_MISMATCH',
      'The Action Cycle resolved-profile fingerprint does not equal the compiled profile fingerprint.',
    );
  }
  if (input.actionCycle.readinessFingerprint !== profileView.componentFingerprints?.readiness) {
    report(
      'ENVELOPE_READINESS_MISMATCH',
      'The Action Cycle readiness fingerprint does not equal the compiled readiness component.',
    );
  }

  if (issues.length > 0) return failure(issues);
  return { profile: profileView };
}

/**
 * Projects the delivered History Oracle primitive observations into explicit
 * structured per-check kernel facts. The explicit structured authority is read
 * from the primitive authority state (not from the legacy aggregate
 * harness-validity flag); chain agreement is the independent raw pre-action
 * chain-correlation primitive; and the product mismatch is the negation of the
 * check's own explicitly named primitive predicate under a current authority.
 * No legacy composite boolean check result is read or translated.
 */
export function projectHistoryLiveFacts(
  observation: HistoryLiveEvaluationObservation,
): HistoryEvaluatorFact[] {
  const primitive = observation.primitiveFacts;
  const authority: HistoryAuthorityState =
    primitive.authority === 'malformed' ? 'malformed' : 'current';
  const chainAgrees = primitive.preActionChainCorrelates === true;
  return primitive.checks.map((check) => ({
    checkId: check.checkId,
    authority,
    currentness: historyCurrentnessForAuthority(authority),
    sourcesAgree: chainAgrees,
    mismatch: authority === 'malformed' ? false : check.predicateMet !== true,
  }));
}

/** Projects the additive primitive facts into the kernel's raw authority view. */
function projectOracleFacts(observation: HistoryLiveEvaluationObservation): HistoryOracleFactsView {
  const primitive = observation.primitiveFacts;
  return {
    authority: primitive.authority,
    chainAgreement: primitive.preActionChainCorrelates === true,
    retainedLayoutId: primitive.retainedLayoutId === null ? null : primitive.retainedLayoutId,
    setup: primitive.setup === null ? null : primitive.setup.map((entry) => ({ ...entry })),
    transitions:
      primitive.transitions === null ? null : primitive.transitions.map((entry) => ({ ...entry })),
    finalHistory: primitive.finalHistory === null ? null : { ...primitive.finalHistory },
    checks: primitive.checks.map((check) => ({
      checkId: check.checkId,
      predicateMet: check.predicateMet === true,
    })),
  };
}

function isLivePrimitiveCheck(value: unknown): value is HistoryLivePrimitiveCheckObservation {
  return (
    isPlainRecord(value) &&
    typeof value.checkId === 'string' &&
    typeof value.predicateMet === 'boolean'
  );
}

function isLivePrimitiveTuple(value: unknown): value is HistoryKernelTupleView {
  return (
    isPlainRecord(value) &&
    typeof value.pastDepth === 'number' &&
    typeof value.futureDepth === 'number' &&
    typeof value.baselineClean === 'boolean'
  );
}

function isLivePrimitiveSetup(value: unknown): value is HistoryLivePrimitiveSetupObservation {
  return (
    isPlainRecord(value) &&
    typeof value.checkpointId === 'string' &&
    typeof value.role === 'string' &&
    typeof value.meaning === 'string' &&
    typeof value.pastDepth === 'number' &&
    typeof value.futureDepth === 'number' &&
    typeof value.baselineClean === 'boolean' &&
    typeof value.meaningFingerprint === 'string'
  );
}

function isLivePrimitiveTransition(
  value: unknown,
): value is HistoryLivePrimitiveTransitionObservation {
  if (!isPlainRecord(value)) return false;
  if (typeof value.order !== 'number') return false;
  if (typeof value.stepIndex !== 'number') return false;
  if (typeof value.stepId !== 'string') return false;
  if (typeof value.control !== 'string') return false;
  if (typeof value.controlAccessibleName !== 'string') return false;
  if (typeof value.controlTitle !== 'string') return false;
  if (typeof value.controlNativeTag !== 'string') return false;
  if (value.controlButtonType !== null && typeof value.controlButtonType !== 'string') return false;
  if (typeof value.controlVisible !== 'boolean') return false;
  if (typeof value.controlEnabledBeforeDispatch !== 'boolean') return false;
  if (typeof value.dispatchCount !== 'number') return false;
  if (value.actionEpochId !== null && typeof value.actionEpochId !== 'string') return false;
  if (value.observationId !== null && typeof value.observationId !== 'string') return false;
  if (typeof value.preActionRevision !== 'number') return false;
  if (typeof value.postActionRevision !== 'number') return false;
  if (typeof value.revisionAdvanced !== 'boolean') return false;
  if (value.idle !== null) {
    if (!isPlainRecord(value.idle)) return false;
    if (typeof value.idle.stableFrames !== 'number') return false;
    if (typeof value.idle.waitedMs !== 'number') return false;
    if (typeof value.idle.observationRevision !== 'number') return false;
  }
  if (!isLivePrimitiveTuple(value.historyBefore)) return false;
  if (!isLivePrimitiveTuple(value.historyAfter)) return false;
  if (!isLivePrimitiveTuple(value.expectedHistory)) return false;
  if (typeof value.historyTupleExact !== 'boolean') return false;
  if (typeof value.expectedMeaning !== 'string') return false;
  if (value.meaningFingerprint !== null && typeof value.meaningFingerprint !== 'string') {
    return false;
  }
  if (
    value.expectedMeaningFingerprint !== null &&
    typeof value.expectedMeaningFingerprint !== 'string'
  ) {
    return false;
  }
  if (typeof value.meaningStructurallyEqual !== 'boolean') return false;
  if (typeof value.transitionObserved !== 'boolean') return false;
  if (typeof value.tornRecaptureCount !== 'number') return false;
  return true;
}

function isLivePrimitiveFacts(value: unknown): value is HistoryLivePrimitiveFactsObservation {
  if (!isPlainRecord(value)) return false;
  if (!isLivePrimitiveAuthority(value.authority)) return false;
  if (value.retainedLayoutId !== null && typeof value.retainedLayoutId !== 'string') return false;
  if (value.setup !== null) {
    if (!Array.isArray(value.setup)) return false;
    if (!value.setup.every(isLivePrimitiveSetup)) return false;
  }
  if (value.transitions !== null) {
    if (!Array.isArray(value.transitions)) return false;
    if (!value.transitions.every(isLivePrimitiveTransition)) return false;
  }
  if (value.finalHistory !== null && !isLivePrimitiveTuple(value.finalHistory)) return false;
  if (typeof value.preActionChainCorrelates !== 'boolean') return false;
  if (!Array.isArray(value.checks)) return false;
  return value.checks.every(isLivePrimitiveCheck);
}

function isDiagnostics(
  value: unknown,
): value is readonly { readonly code: string; readonly detail: string }[] {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        isPlainRecord(entry) && typeof entry.code === 'string' && typeof entry.detail === 'string',
    )
  );
}

function isHistoryObservation(value: unknown): value is HistoryLiveEvaluationObservation {
  if (!isPlainRecord(value)) return false;
  if (!isLivePrimitiveFacts(value.primitiveFacts)) return false;
  return value.diagnostics === undefined || isDiagnostics(value.diagnostics);
}

/** Common pre-kernel checks shared by the History adapter. */
function validateCommon(input: {
  envelope: MaterializedExecutionEnvelopeV1;
  route: HistoryLiveFactRoute;
  actionCycle: ActionCycleCorrectnessIdentity;
  family: FamilyContract;
  evidence: unknown;
}): EnvelopeAgreement | HistoryLiveFactFailure {
  if (!isEvidenceFactArray(input.evidence)) {
    return failure([
      {
        code: 'HISTORY_LIVE_EVIDENCE_FACT_INVALID',
        detail:
          'Every observed evidence fact must carry a string evidenceId and a known availability; the adapter never invents an evidence role.',
      },
    ]);
  }
  return validateEnvelope(input);
}

/**
 * Adapts the delivered History live observations into the structured kernel
 * fact input, or fails closed before the kernel on any exact-envelope or
 * observation disagreement.
 */
export function adaptHistoryLiveFacts(
  input: HistoryLiveFactAdapterInput,
): HistoryLiveFactAdaptation<HistoryKernelFacts> {
  const agreement = validateCommon({
    envelope: input.envelope,
    route: input.route,
    actionCycle: input.actionCycle,
    family: HISTORY_FAMILY,
    evidence: input.evidence,
  });
  if ('ok' in agreement) return agreement;

  if (input.oracle !== null && !isHistoryObservation(input.oracle)) {
    return failure([
      {
        code: 'HISTORY_LIVE_OBSERVATION_MALFORMED',
        detail:
          'The History Oracle observation does not carry the accepted additive primitive facts and cannot be interpreted.',
      },
    ]);
  }
  const observation = input.oracle;
  return {
    ok: true,
    facts: {
      evaluator: HISTORY_KERNEL_EVALUATOR,
      retainedLayoutId: input.retainedLayoutId,
      setup: input.setup,
      actions: input.actions,
      finalHistory: input.finalHistory,
      readiness: input.readiness as HistoryReadinessFact,
      checks: observation === null ? [] : projectHistoryLiveFacts(observation),
      oracleFacts: observation === null ? null : projectOracleFacts(observation),
      diagnostics: observation === null ? [] : [...(observation.diagnostics ?? [])],
      evidence: input.evidence,
    },
  };
}

export type HistoryLiveCheckOutcome =
  | {
      readonly ok: true;
      readonly facts: HistoryKernelFacts;
      readonly result: HistoryKernelResult;
    }
  | HistoryLiveFactFailure;

/**
 * Fail-closed composition: the exact-envelope adversarial validation runs
 * before the adapter and the accepted kernel runs only when adaptation
 * succeeded, so a disagreeing envelope can never reach the kernel.
 */
export function evaluateHistoryLiveChecks(
  input: HistoryLiveFactAdapterInput,
): HistoryLiveCheckOutcome {
  const adaptation = adaptHistoryLiveFacts(input);
  if (!adaptation.ok) return adaptation;
  const result = evaluateHistoryChecks({
    profile: input.envelope.correctnessProfile as unknown as ResolvedCorrectnessProfile,
    route: input.route,
    actionCycle: input.actionCycle,
    facts: adaptation.facts,
  });
  return { ok: true, facts: adaptation.facts, result };
}
