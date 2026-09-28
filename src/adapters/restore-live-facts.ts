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
import type {
  RestoreMeaningFactView,
  RestoreRawSemanticFactView,
  RestoreTransitionFactView,
} from '../contracts/restore-observation';
import { RESOLVED_CORRECTNESS_PROFILE_SCHEMA_VERSION } from '../contracts/schema-versions';
import {
  RESTORE_KERNEL_CHECK_EVALUATORS,
  RESTORE_KERNEL_EVALUATOR,
  evaluateRestoreChecks,
  isRestoreEvidenceAvailability,
  restoreCurrentnessForAuthority,
  type RestoreAuthorityState,
  type RestoreEvaluatorFact,
  type RestoreEvidenceFact,
  type RestoreKernelFacts,
  type RestoreKernelResult,
  type RestoreOracleFactsView,
  type RestoreReadinessFact,
} from '../kernels/restore-kernel';
import {
  MATERIALIZED_EXECUTION_ENVELOPE_SCHEMA_VERSION,
  type MaterializedExecutionEnvelopeV1,
} from '../planner/execution-materialization';

/**
 * P7-B2-B5 inactive live-fact adapter for frontend serialize/restore (ADR 0029
 * §4 B2-B, the restore half; the History half is the B2-B5 History adapter).
 *
 * The adapter sits between the delivered live frontend serialize/restore
 * execution chain and the accepted inactive frontend serialize/restore kernel.
 * It receives exactly the things the delivered restore drive already produced:
 *
 *  1. the exact `MaterializedExecutionEnvelopeV1` compiled once during planning;
 *  2. the route identity (Subject/Capability/variant) of the planned case;
 *  3. the Action Cycle correctness identity that observed the round trip;
 *  4. the delivered restore observation schema version;
 *  5. the delivered raw transition, normalized-meaning, and raw-semantics
 *     views, validated by the kernel;
 *  6. the accepted coherent source and restored document observations,
 *     validated by the kernel;
 *  7. the accepted source-construction setup checkpoints and the accepted
 *     readiness policy/observation, validated by the kernel;
 *  8. the live Restore Oracle additive primitive facts and diagnostics; and
 *  9. the observed evidence roles for the round-trip chain.
 *
 * It returns the structured kernel fact input for `evaluateRestoreChecks`, or
 * fails closed *before* the kernel when the exact envelope, route, Action Cycle,
 * or observation is not in agreement.
 *
 * The adapter provides **facts only**. It owns no required-check array, no
 * profile id or fallback id, no deadline/tolerance/visual/normalization literal,
 * no readiness/transition/meaning/raw-semantics policy, no evidence-role
 * default, no authoring-catalogue access, and no Subject/family/scenario branch.
 * It deliberately does not import any active executor, Oracle, CLI, browser,
 * writer, classifier, or catalogue module: the live observations are consumed
 * through structural contracts that the delivered Oracle evaluation already
 * satisfies. The delivered Oracle's legacy composite check-result booleans and
 * its aggregate harness-validity flag are never read: every structured
 * authority/currentness/source-correlation/mismatch fact is derived only from
 * the Oracle's additive, explicitly named primitive facts (its explicit
 * authority, the independent source/restored correlation primitive, the raw
 * transition/normalized-meaning/raw-semantics views, and one explicit per-check
 * predicate), and no boolean check result is translated into a status here.
 *
 * The module is entirely inactive: it is not re-exported from `src/index.ts` and
 * is referenced only by its focused foundation tests.
 */

/** Closed adapter issue vocabulary; deliberately local to the inactive adapter. */
export const RESTORE_LIVE_FACT_ISSUE_CODES = [
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
  'RESTORE_LIVE_OBSERVATION_MALFORMED',
  'RESTORE_LIVE_EVIDENCE_FACT_INVALID',
] as const;
export type RestoreLiveFactIssueCode = (typeof RESTORE_LIVE_FACT_ISSUE_CODES)[number];

const PRIMARY_DIAGNOSTIC_CODE: Readonly<Record<RestoreLiveFactIssueCode, DiagnosticCode>> =
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
    RESTORE_LIVE_OBSERVATION_MALFORMED: 'UNUSABLE_EVIDENCE',
    RESTORE_LIVE_EVIDENCE_FACT_INVALID: 'UNUSABLE_EVIDENCE',
  } satisfies Record<RestoreLiveFactIssueCode, DiagnosticCode>);

export interface RestoreLiveFactIssue {
  readonly code: RestoreLiveFactIssueCode;
  readonly detail: string;
}

export interface RestoreLiveFactFailure {
  readonly ok: false;
  readonly status: 'HARNESS_BLOCKED';
  readonly launchAttempted: false;
  readonly code: DiagnosticCode;
  readonly diagnostic: DiagnosticRecord;
  readonly issues: readonly RestoreLiveFactIssue[];
}

export type RestoreLiveFactAdaptation<Facts> =
  | { readonly ok: true; readonly facts: Facts }
  | RestoreLiveFactFailure;

/** The route identity a planned case asked the adapter to evaluate. */
export interface RestoreLiveFactRoute {
  readonly subjectId: string;
  readonly capability: Capability;
  readonly variant: string | null;
}

/** One admitted evidence fact; the adapter never invents a role. */
export type RestoreLiveEvidenceFact = RestoreEvidenceFact;

/** Closed explicit authority vocabulary of the additive primitive facts. */
export const RESTORE_LIVE_PRIMITIVE_AUTHORITIES = ['current', 'malformed'] as const;
export type RestoreLivePrimitiveAuthority = (typeof RESTORE_LIVE_PRIMITIVE_AUTHORITIES)[number];

function isLivePrimitiveAuthority(value: unknown): value is RestoreLivePrimitiveAuthority {
  return (
    typeof value === 'string' &&
    (RESTORE_LIVE_PRIMITIVE_AUTHORITIES as readonly string[]).includes(value)
  );
}

/**
 * One explicit per-check primitive predicate of the delivered Restore Oracle
 * evaluation. `predicateMet` is the Oracle's own per-check predicate derived
 * from the raw accepted round-trip facts (the complete Save → POST → redirect →
 * GET → mount transition, the exact normalized meaning, and the raw
 * Crossword/config/server-metadata checks); it is not a legacy composite
 * check-result boolean.
 */
export interface RestoreLivePrimitiveCheckObservation {
  readonly checkId: string;
  readonly predicateMet: boolean;
}

/**
 * The additive primitive facts of the delivered Restore Oracle evaluation the
 * adapter is allowed to read (ADR 0029 §4 B2-B): an explicit structured
 * authority, the independent source/restored document correlation primitive,
 * the raw accepted transition/normalized-meaning/raw-semantics views, and one
 * explicit per-check predicate. The delivered Oracle's legacy composite
 * check-result booleans and its aggregate harness-validity flag are deliberately
 * not part of this view. A malformed evaluation carries no readable primitive
 * view at all.
 */
export interface RestoreLivePrimitiveFactsObservation {
  readonly authority: RestoreLivePrimitiveAuthority;
  readonly schemaVersion: number;
  readonly sourceAgreement: boolean;
  readonly transition: RestoreTransitionFactView | null;
  readonly meaning: RestoreMeaningFactView | null;
  readonly rawSemantics: RestoreRawSemanticFactView | null;
  readonly checks: readonly RestoreLivePrimitiveCheckObservation[];
}

/**
 * Structural projection of the delivered Restore Oracle evaluation
 * (`RestoreOracleEvaluation`). The additive `primitiveFacts` view and the raw
 * diagnostics are carried; the legacy aggregate harness-validity flag and
 * per-check boolean check results are not.
 */
export interface RestoreLiveEvaluationObservation {
  readonly primitiveFacts: RestoreLivePrimitiveFactsObservation;
  readonly diagnostics?: readonly { readonly code: string; readonly detail: string }[];
}

export interface RestoreLiveFactAdapterInput {
  readonly envelope: MaterializedExecutionEnvelopeV1;
  readonly route: RestoreLiveFactRoute;
  readonly actionCycle: ActionCycleCorrectnessIdentity;
  /** The delivered restore observation schema version; never defaulted. */
  readonly schemaVersion: number;
  /** The delivered raw transition view; validated by the kernel. */
  readonly transition: unknown;
  /** The delivered raw normalized-meaning view; validated by the kernel. */
  readonly meaning: unknown;
  /** The delivered raw raw-semantics view; validated by the kernel. */
  readonly rawSemantics: unknown;
  /** The accepted coherent source document observation; validated by the kernel. */
  readonly source: unknown;
  /** The accepted coherent restored document observation; validated by the kernel. */
  readonly restored: unknown;
  /** The accepted source-construction setup checkpoints; validated by the kernel. */
  readonly setup: readonly unknown[];
  /** The accepted readiness policy and observation; validated by the kernel. */
  readonly readiness: unknown;
  /** The accepted Restore Oracle evaluation, or `null` when it never ran. */
  readonly oracle: RestoreLiveEvaluationObservation | null;
  /** The observed evidence roles; the adapter never invents a role. */
  readonly evidence: readonly RestoreLiveEvidenceFact[];
}

interface FamilyContract {
  readonly oracleEvaluatorKind: string;
  readonly checkEvaluators: readonly string[];
}

const RESTORE_FAMILY: FamilyContract = Object.freeze({
  oracleEvaluatorKind: RESTORE_KERNEL_EVALUATOR,
  checkEvaluators: RESTORE_KERNEL_CHECK_EVALUATORS,
});

function failure(issues: readonly RestoreLiveFactIssue[]): RestoreLiveFactFailure {
  const primary = issues[0] as RestoreLiveFactIssue;
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

function isEvidenceFactArray(value: unknown): value is readonly RestoreEvidenceFact[] {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        isPlainRecord(entry) &&
        typeof entry.evidenceId === 'string' &&
        isRestoreEvidenceAvailability(entry.availability),
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
  route: RestoreLiveFactRoute;
  actionCycle: ActionCycleCorrectnessIdentity;
  family: FamilyContract;
}): EnvelopeAgreement | RestoreLiveFactFailure {
  const issues: RestoreLiveFactIssue[] = [];
  const report = (code: RestoreLiveFactIssueCode, detail: string): void => {
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
      `Compiled Oracle evaluator "${String(oracleKind)}" is not supported by this restore adapter (expected "${input.family.oracleEvaluatorKind}").`,
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
        `Required check "${checkId}" declares evaluator "${String(contract.evaluator)}" which this restore adapter does not support.`,
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
 * Projects the delivered Restore Oracle primitive observations into explicit
 * structured per-check kernel facts. The explicit structured authority is read
 * from the primitive authority state (not from the legacy aggregate
 * harness-validity flag); source agreement is the independent raw
 * source/restored correlation primitive; and the product mismatch is the
 * negation of the check's own explicitly named primitive predicate under a
 * current authority. No legacy composite boolean check result is read or
 * translated.
 */
export function projectRestoreLiveFacts(
  observation: RestoreLiveEvaluationObservation,
): RestoreEvaluatorFact[] {
  const primitive = observation.primitiveFacts;
  const authority: RestoreAuthorityState =
    primitive.authority === 'malformed' ? 'malformed' : 'current';
  const sourcesAgree = primitive.sourceAgreement === true;
  return primitive.checks.map((check) => ({
    checkId: check.checkId,
    authority,
    currentness: restoreCurrentnessForAuthority(authority),
    sourcesAgree,
    mismatch: authority === 'malformed' ? false : check.predicateMet !== true,
  }));
}

/** Projects the additive primitive facts into the kernel's raw authority view. */
function projectOracleFacts(observation: RestoreLiveEvaluationObservation): RestoreOracleFactsView {
  const primitive = observation.primitiveFacts;
  return {
    authority: primitive.authority,
    schemaVersion: primitive.schemaVersion,
    sourceAgreement: primitive.sourceAgreement === true,
    transition: primitive.transition === null ? null : { ...primitive.transition },
    meaning: primitive.meaning === null ? null : { ...primitive.meaning },
    rawSemantics:
      primitive.rawSemantics === null
        ? null
        : { ...primitive.rawSemantics, words: [...primitive.rawSemantics.words] },
    checks: primitive.checks.map((check) => ({
      checkId: check.checkId,
      predicateMet: check.predicateMet === true,
    })),
  };
}

function isLivePrimitiveCheck(value: unknown): value is RestoreLivePrimitiveCheckObservation {
  return (
    isPlainRecord(value) &&
    typeof value.checkId === 'string' &&
    typeof value.predicateMet === 'boolean'
  );
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isNullableNumber(value: unknown): value is number | null {
  return value === null || typeof value === 'number';
}

function isLivePrimitiveTransition(value: unknown): value is RestoreTransitionFactView {
  if (!isPlainRecord(value)) return false;
  const booleans = [
    'saveDispatchedOnce',
    'createMethodMatches',
    'createPathMatches',
    'createContentTypeMatches',
    'createAfterEpoch',
    'getMethodMatches',
    'getPathMatches',
    'redirectObserved',
    'navigateRouteMatches',
    'documentIdentityDistinct',
    'restoredHistoryClean',
  ] as const;
  for (const field of booleans) {
    if (typeof value[field] !== 'boolean') return false;
  }
  for (const field of ['createRequestCount', 'getRequestCount'] as const) {
    if (typeof value[field] !== 'number') return false;
  }
  for (const field of ['harnessHydrateCalls', 'harnessStoreMutationCalls'] as const) {
    if (typeof value[field] !== 'number') return false;
  }
  return true;
}

function isLivePrimitiveMeaning(value: unknown): value is RestoreMeaningFactView {
  if (!isPlainRecord(value)) return false;
  for (const field of [
    'normalizedStructurallyEqual',
    'normalizedFingerprintEqual',
    'inventoryPreserved',
    'persistenceLossDetected',
  ] as const) {
    if (typeof value[field] !== 'boolean') return false;
  }
  return isNullableString(value.sourceFingerprint) && isNullableString(value.restoredFingerprint);
}

function isLivePrimitiveRawSemantic(value: unknown): value is RestoreRawSemanticFactView {
  if (!isPlainRecord(value)) return false;
  for (const field of [
    'crosswordPresent',
    'restoredSeedMatches',
    'restoredWordsMatch',
    'restoredLayoutDigestMatches',
    'rawConfigPresent',
    'rawServerMetadataPresent',
    'normalizedHasNoIdKey',
    'normalizedHasNoConfigKey',
    'normalizedHasNoServerMetadata',
    'volatileIdsDiffer',
  ] as const) {
    if (typeof value[field] !== 'boolean') return false;
  }
  if (!Array.isArray(value.words) || !value.words.every((entry) => typeof entry === 'string')) {
    return false;
  }
  return isNullableNumber(value.generationSeed) && isNullableString(value.layoutDigest);
}

function isLivePrimitiveFacts(value: unknown): value is RestoreLivePrimitiveFactsObservation {
  if (!isPlainRecord(value)) return false;
  if (!isLivePrimitiveAuthority(value.authority)) return false;
  if (typeof value.schemaVersion !== 'number') return false;
  if (typeof value.sourceAgreement !== 'boolean') return false;
  if (value.transition !== null && !isLivePrimitiveTransition(value.transition)) return false;
  if (value.meaning !== null && !isLivePrimitiveMeaning(value.meaning)) return false;
  if (value.rawSemantics !== null && !isLivePrimitiveRawSemantic(value.rawSemantics)) return false;
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

function isRestoreObservation(value: unknown): value is RestoreLiveEvaluationObservation {
  if (!isPlainRecord(value)) return false;
  if (!isLivePrimitiveFacts(value.primitiveFacts)) return false;
  return value.diagnostics === undefined || isDiagnostics(value.diagnostics);
}

/** Common pre-kernel checks shared by the Restore adapter. */
function validateCommon(input: {
  envelope: MaterializedExecutionEnvelopeV1;
  route: RestoreLiveFactRoute;
  actionCycle: ActionCycleCorrectnessIdentity;
  family: FamilyContract;
  evidence: unknown;
}): EnvelopeAgreement | RestoreLiveFactFailure {
  if (!isEvidenceFactArray(input.evidence)) {
    return failure([
      {
        code: 'RESTORE_LIVE_EVIDENCE_FACT_INVALID',
        detail:
          'Every observed evidence fact must carry a string evidenceId and a known availability; the adapter never invents an evidence role.',
      },
    ]);
  }
  return validateEnvelope(input);
}

/**
 * Adapts the delivered Restore live observations into the structured kernel
 * fact input, or fails closed before the kernel on any exact-envelope or
 * observation disagreement.
 */
export function adaptRestoreLiveFacts(
  input: RestoreLiveFactAdapterInput,
): RestoreLiveFactAdaptation<RestoreKernelFacts> {
  const agreement = validateCommon({
    envelope: input.envelope,
    route: input.route,
    actionCycle: input.actionCycle,
    family: RESTORE_FAMILY,
    evidence: input.evidence,
  });
  if ('ok' in agreement) return agreement;

  if (input.oracle !== null && !isRestoreObservation(input.oracle)) {
    return failure([
      {
        code: 'RESTORE_LIVE_OBSERVATION_MALFORMED',
        detail:
          'The Restore Oracle observation does not carry the accepted additive primitive facts and cannot be interpreted.',
      },
    ]);
  }
  const observation = input.oracle;
  return {
    ok: true,
    facts: {
      evaluator: RESTORE_KERNEL_EVALUATOR,
      schemaVersion: input.schemaVersion,
      transition: input.transition as RestoreTransitionFactView,
      meaning: input.meaning as RestoreMeaningFactView,
      rawSemantics: input.rawSemantics as RestoreRawSemanticFactView,
      source: input.source,
      restored: input.restored,
      setup: input.setup,
      readiness: input.readiness as RestoreReadinessFact,
      checks: observation === null ? [] : projectRestoreLiveFacts(observation),
      oracleFacts: observation === null ? null : projectOracleFacts(observation),
      diagnostics: observation === null ? [] : [...(observation.diagnostics ?? [])],
      evidence: input.evidence,
    },
  };
}

export type RestoreLiveCheckOutcome =
  | {
      readonly ok: true;
      readonly facts: RestoreKernelFacts;
      readonly result: RestoreKernelResult;
    }
  | RestoreLiveFactFailure;

/**
 * Fail-closed composition: the exact-envelope adversarial validation runs
 * before the adapter and the accepted kernel runs only when adaptation
 * succeeded, so a disagreeing envelope can never reach the kernel.
 */
export function evaluateRestoreLiveChecks(
  input: RestoreLiveFactAdapterInput,
): RestoreLiveCheckOutcome {
  const adaptation = adaptRestoreLiveFacts(input);
  if (!adaptation.ok) return adaptation;
  const result = evaluateRestoreChecks({
    profile: input.envelope.correctnessProfile as unknown as ResolvedCorrectnessProfile,
    route: input.route,
    actionCycle: input.actionCycle,
    facts: adaptation.facts,
  });
  return { ok: true, facts: adaptation.facts, result };
}
