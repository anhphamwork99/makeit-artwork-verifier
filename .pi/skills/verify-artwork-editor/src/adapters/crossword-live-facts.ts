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
  CROSSWORD_KERNEL_CHECK_EVALUATORS,
  CROSSWORD_KERNEL_EVALUATOR,
  crosswordCurrentnessForAuthority,
  evaluateCrosswordChecks,
  isCrosswordEvidenceAvailability,
  type CrosswordAuthorityState,
  type CrosswordEvaluatorFact,
  type CrosswordEvidenceFact,
  type CrosswordKernelFacts,
  type CrosswordKernelResult,
  type CrosswordOracleFactsView,
} from '../kernels/crossword-kernel';
import {
  MATERIALIZED_EXECUTION_ENVELOPE_SCHEMA_VERSION,
  type MaterializedExecutionEnvelopeV1,
} from '../planner/execution-materialization';

/**
 * P7-B2-B4 inactive live-fact adapter for generated Crossword
 * creation/determinism (ADR 0029 §4 B2-B).
 *
 * The adapter sits between the delivered live Crossword runtime observations and
 * the accepted inactive Crossword kernel. It receives exactly the things the
 * delivered Crossword Action Cycle already produced:
 *
 *  1. the exact `MaterializedExecutionEnvelopeV1` compiled once during planning;
 *  2. the route identity (Subject/Capability/variant) of the planned case;
 *  3. the Action Cycle correctness identity that observed the action;
 *  4. the accepted governed fixed-wall clock profile and the accepted
 *     source-contract fingerprint the materialization binds;
 *  5. the delivered three-child execution observations (seed + generated layout +
 *     semantic digest + currentness + raster authority) and the accepted
 *     three-child comparison projection;
 *  6. the live Crossword Oracle additive primitive facts and diagnostics; and
 *  7. the observed evidence roles for the Action Cycle.
 *
 * It returns the structured kernel fact input for `evaluateCrosswordChecks`, or
 * fails closed *before* the kernel when the exact envelope, route, Action Cycle,
 * or observation is not in agreement.
 *
 * The adapter provides **facts only**. It owns no required-check array, no
 * profile id or fallback id, no deadline/tolerance/visual/normalization literal,
 * no seed/word/layout policy, no evidence-role default, no authoring-catalogue
 * access, and no Subject/family/scenario branch. It deliberately does not import
 * any active executor, Oracle, CLI, browser, writer, classifier, or catalogue
 * module: the live observations are consumed through structural contracts that
 * the delivered Oracle evaluation already satisfies. The delivered Oracle's
 * legacy composite check-result booleans and its aggregate harness-validity flag
 * are never read: every structured authority/currentness/source-agreement/
 * mismatch fact is derived only from the Oracle's additive, explicitly named
 * primitive facts, and no boolean check result is translated into a final status
 * here.
 *
 * The module is entirely inactive: it is not re-exported from `src/index.ts` and
 * is referenced only by its focused foundation tests.
 */

/** Closed adapter issue vocabulary; deliberately local to the inactive adapter. */
export const CROSSWORD_LIVE_FACT_ISSUE_CODES = [
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
  'CROSSWORD_LIVE_OBSERVATION_MALFORMED',
  'CROSSWORD_LIVE_EVIDENCE_FACT_INVALID',
] as const;
export type CrosswordLiveFactIssueCode = (typeof CROSSWORD_LIVE_FACT_ISSUE_CODES)[number];

const PRIMARY_DIAGNOSTIC_CODE: Readonly<Record<CrosswordLiveFactIssueCode, DiagnosticCode>> =
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
    CROSSWORD_LIVE_OBSERVATION_MALFORMED: 'UNUSABLE_EVIDENCE',
    CROSSWORD_LIVE_EVIDENCE_FACT_INVALID: 'UNUSABLE_EVIDENCE',
  } satisfies Record<CrosswordLiveFactIssueCode, DiagnosticCode>);

export interface CrosswordLiveFactIssue {
  readonly code: CrosswordLiveFactIssueCode;
  readonly detail: string;
}

export interface CrosswordLiveFactFailure {
  readonly ok: false;
  readonly status: 'HARNESS_BLOCKED';
  readonly launchAttempted: false;
  readonly code: DiagnosticCode;
  readonly diagnostic: DiagnosticRecord;
  readonly issues: readonly CrosswordLiveFactIssue[];
}

export type CrosswordLiveFactAdaptation<Facts> =
  | { readonly ok: true; readonly facts: Facts }
  | CrosswordLiveFactFailure;

/** The route identity a planned case asked the adapter to evaluate. */
export interface CrosswordLiveFactRoute {
  readonly subjectId: string;
  readonly capability: Capability;
  readonly variant: string | null;
}

/** One admitted evidence fact; the adapter never invents a role. */
export type CrosswordLiveEvidenceFact = CrosswordEvidenceFact;

/** Closed explicit authority vocabulary of the additive primitive facts. */
export const CROSSWORD_LIVE_PRIMITIVE_AUTHORITIES = ['current', 'malformed'] as const;
export type CrosswordLivePrimitiveAuthority = (typeof CROSSWORD_LIVE_PRIMITIVE_AUTHORITIES)[number];

function isLivePrimitiveAuthority(value: unknown): value is CrosswordLivePrimitiveAuthority {
  return (
    typeof value === 'string' &&
    (CROSSWORD_LIVE_PRIMITIVE_AUTHORITIES as readonly string[]).includes(value)
  );
}

/**
 * One explicit per-check primitive predicate of the delivered Crossword Oracle
 * evaluation. `predicateMet` is the Oracle's own per-check predicate derived from
 * the raw child comparison/repeat/seed-sensitivity/collision/currentness/raster
 * and governed clock observations; it is not a legacy composite check-result
 * boolean.
 */
export interface CrosswordLivePrimitiveCheckObservation {
  readonly checkId: string;
  readonly predicateMet: boolean;
}

/**
 * Raw accepted three-child comparison primitives of the delivered Oracle: the
 * A1/A2 same-seed repeat identity, the A1/B seed-sensitivity control, the A1/B
 * different-seed collision, and fresh-document distinctness.
 */
export interface CrosswordLivePrimitiveComparisonObservation {
  readonly sameSeedPair: boolean;
  readonly differentSeedPair: boolean;
  readonly repeatIdentical: boolean;
  readonly seedSensitivity: boolean;
  readonly collision: boolean;
  readonly wordsEqualAcrossChildren: boolean;
  readonly distinctDocuments: boolean;
}

/**
 * The additive primitive facts of the delivered Crossword Oracle evaluation the
 * adapter is allowed to read (ADR 0029 §4 B2-B): an explicit structured
 * authority, the independent governed-clock/source-agreement primitive, the raw
 * accepted child-comparison/repeat/sensitivity/collision, governed clock,
 * currentness, and raster primitives, and one explicit per-check predicate. The
 * delivered Oracle's legacy composite check-result booleans and its aggregate
 * harness-validity flag are deliberately not part of this view.
 */
export interface CrosswordLivePrimitiveFactsObservation {
  readonly authority: CrosswordLivePrimitiveAuthority;
  readonly sourceAgreement: boolean;
  readonly comparison: CrosswordLivePrimitiveComparisonObservation | null;
  readonly clockEpochs: readonly number[] | null;
  readonly currentnessDistinct: boolean;
  readonly rasterCurrent: boolean;
  readonly checks: readonly CrosswordLivePrimitiveCheckObservation[];
}

/**
 * Structural projection of the delivered Crossword Oracle evaluation
 * (`CrosswordOracleEvaluation`). The additive `primitiveFacts` view, the accepted
 * comparison projection, and the raw diagnostics are carried; the legacy
 * aggregate harness-validity flag and per-check boolean check results are not.
 */
export interface CrosswordLiveEvaluationObservation {
  readonly primitiveFacts: CrosswordLivePrimitiveFactsObservation;
  readonly comparison?: CrosswordKernelFacts['comparison'];
  readonly diagnostics?: readonly { readonly code: string; readonly detail: string }[];
}

export interface CrosswordLiveFactAdapterInput {
  readonly envelope: MaterializedExecutionEnvelopeV1;
  readonly route: CrosswordLiveFactRoute;
  readonly actionCycle: ActionCycleCorrectnessIdentity;
  /** The accepted governed fixed-wall clock profile the drive installed. */
  readonly clock: unknown;
  /** The accepted source-contract fingerprint the materialization binds. */
  readonly sourceFingerprintExpected: string;
  /** The delivered three-child execution observations; validated by the kernel. */
  readonly executions: readonly unknown[];
  /** The accepted Crossword Oracle evaluation, or `null` when it never ran. */
  readonly oracle: CrosswordLiveEvaluationObservation | null;
  /** The observed evidence roles; the adapter never invents a role. */
  readonly evidence: readonly CrosswordLiveEvidenceFact[];
}

interface FamilyContract {
  readonly oracleEvaluatorKind: string;
  readonly checkEvaluators: readonly string[];
}

const CROSSWORD_FAMILY: FamilyContract = Object.freeze({
  oracleEvaluatorKind: CROSSWORD_KERNEL_EVALUATOR,
  checkEvaluators: CROSSWORD_KERNEL_CHECK_EVALUATORS,
});

function failure(issues: readonly CrosswordLiveFactIssue[]): CrosswordLiveFactFailure {
  const primary = issues[0] as CrosswordLiveFactIssue;
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

function isEvidenceFactArray(value: unknown): value is readonly CrosswordEvidenceFact[] {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        isPlainRecord(entry) &&
        typeof entry.evidenceId === 'string' &&
        isCrosswordEvidenceAvailability(entry.availability),
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
  route: CrosswordLiveFactRoute;
  actionCycle: ActionCycleCorrectnessIdentity;
  family: FamilyContract;
}): EnvelopeAgreement | CrosswordLiveFactFailure {
  const issues: CrosswordLiveFactIssue[] = [];
  const report = (code: CrosswordLiveFactIssueCode, detail: string): void => {
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
      `Compiled Oracle evaluator "${String(oracleKind)}" is not supported by this Crossword adapter (expected "${input.family.oracleEvaluatorKind}").`,
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
        `Required check "${checkId}" declares evaluator "${String(contract.evaluator)}" which this Crossword adapter does not support.`,
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
 * Projects the delivered Crossword Oracle primitive observations into explicit
 * structured per-check kernel facts. The explicit structured authority is read
 * from the primitive authority state (not from the legacy aggregate
 * harness-validity flag); source agreement is the independent
 * governed-clock/source-agreement primitive; and the product mismatch is the
 * negation of the check's own explicitly named primitive predicate under a
 * current authority. No legacy composite boolean check result is read or
 * translated.
 */
export function projectCrosswordLiveFacts(
  observation: CrosswordLiveEvaluationObservation,
): CrosswordEvaluatorFact[] {
  const primitive = observation.primitiveFacts;
  const authority: CrosswordAuthorityState =
    primitive.authority === 'malformed' ? 'malformed' : 'current';
  const sourcesAgree = primitive.sourceAgreement === true;
  return primitive.checks.map((check) => ({
    checkId: check.checkId,
    authority,
    currentness: crosswordCurrentnessForAuthority(authority),
    sourcesAgree,
    mismatch: authority === 'malformed' ? false : check.predicateMet !== true,
  }));
}

/** Projects the additive primitive facts into the kernel's raw authority view. */
function projectOracleFacts(
  observation: CrosswordLiveEvaluationObservation,
): CrosswordOracleFactsView {
  const primitive = observation.primitiveFacts;
  const comparison = primitive.comparison;
  return {
    authority: primitive.authority,
    sourceAgreement: primitive.sourceAgreement === true,
    comparison:
      comparison === null
        ? null
        : {
            sameSeedPair: comparison.sameSeedPair === true,
            differentSeedPair: comparison.differentSeedPair === true,
            repeatIdentical: comparison.repeatIdentical === true,
            seedSensitivity: comparison.seedSensitivity === true,
            collision: comparison.collision === true,
            wordsEqualAcrossChildren: comparison.wordsEqualAcrossChildren === true,
            distinctDocuments: comparison.distinctDocuments === true,
          },
    clockEpochs: Array.isArray(primitive.clockEpochs) ? [...primitive.clockEpochs] : null,
    currentnessDistinct: primitive.currentnessDistinct === true,
    rasterCurrent: primitive.rasterCurrent === true,
    checks: primitive.checks.map((check) => ({
      checkId: check.checkId,
      predicateMet: check.predicateMet === true,
    })),
  };
}

function isLivePrimitiveCheck(value: unknown): value is CrosswordLivePrimitiveCheckObservation {
  return (
    isPlainRecord(value) &&
    typeof value.checkId === 'string' &&
    typeof value.predicateMet === 'boolean'
  );
}

function isLivePrimitiveComparison(
  value: unknown,
): value is CrosswordLivePrimitiveComparisonObservation {
  return (
    isPlainRecord(value) &&
    typeof value.sameSeedPair === 'boolean' &&
    typeof value.differentSeedPair === 'boolean' &&
    typeof value.repeatIdentical === 'boolean' &&
    typeof value.seedSensitivity === 'boolean' &&
    typeof value.collision === 'boolean' &&
    typeof value.wordsEqualAcrossChildren === 'boolean' &&
    typeof value.distinctDocuments === 'boolean'
  );
}

function isLivePrimitiveFacts(value: unknown): value is CrosswordLivePrimitiveFactsObservation {
  if (!isPlainRecord(value)) return false;
  if (!isLivePrimitiveAuthority(value.authority)) return false;
  if (typeof value.sourceAgreement !== 'boolean') return false;
  if (value.comparison !== null && !isLivePrimitiveComparison(value.comparison)) return false;
  if (value.clockEpochs !== null) {
    if (!Array.isArray(value.clockEpochs)) return false;
    if (!value.clockEpochs.every((entry) => typeof entry === 'number')) return false;
  }
  if (typeof value.currentnessDistinct !== 'boolean') return false;
  if (typeof value.rasterCurrent !== 'boolean') return false;
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

function isCrosswordObservation(value: unknown): value is CrosswordLiveEvaluationObservation {
  if (!isPlainRecord(value)) return false;
  if (!isLivePrimitiveFacts(value.primitiveFacts)) return false;
  return value.diagnostics === undefined || isDiagnostics(value.diagnostics);
}

/** Common pre-kernel checks shared by the Crossword adapter. */
function validateCommon(input: {
  envelope: MaterializedExecutionEnvelopeV1;
  route: CrosswordLiveFactRoute;
  actionCycle: ActionCycleCorrectnessIdentity;
  family: FamilyContract;
  evidence: unknown;
}): EnvelopeAgreement | CrosswordLiveFactFailure {
  if (!isEvidenceFactArray(input.evidence)) {
    return failure([
      {
        code: 'CROSSWORD_LIVE_EVIDENCE_FACT_INVALID',
        detail:
          'Every observed evidence fact must carry a string evidenceId and a known availability; the adapter never invents an evidence role.',
      },
    ]);
  }
  return validateEnvelope(input);
}

/**
 * Adapts the delivered Crossword live observations into the structured kernel
 * fact input, or fails closed before the kernel on any exact-envelope or
 * observation disagreement.
 */
export function adaptCrosswordLiveFacts(
  input: CrosswordLiveFactAdapterInput,
): CrosswordLiveFactAdaptation<CrosswordKernelFacts> {
  const agreement = validateCommon({
    envelope: input.envelope,
    route: input.route,
    actionCycle: input.actionCycle,
    family: CROSSWORD_FAMILY,
    evidence: input.evidence,
  });
  if ('ok' in agreement) return agreement;

  if (input.oracle !== null && !isCrosswordObservation(input.oracle)) {
    return failure([
      {
        code: 'CROSSWORD_LIVE_OBSERVATION_MALFORMED',
        detail:
          'The Crossword Oracle observation does not carry the accepted additive primitive facts and cannot be interpreted.',
      },
    ]);
  }
  const observation = input.oracle;
  return {
    ok: true,
    facts: {
      evaluator: CROSSWORD_KERNEL_EVALUATOR,
      clock: input.clock,
      sourceFingerprintExpected: input.sourceFingerprintExpected,
      executions: input.executions,
      checks: observation === null ? [] : projectCrosswordLiveFacts(observation),
      comparison: observation === null ? null : (observation.comparison ?? null),
      oracleFacts: observation === null ? null : projectOracleFacts(observation),
      diagnostics: observation === null ? [] : [...(observation.diagnostics ?? [])],
      evidence: input.evidence,
    },
  };
}

export type CrosswordLiveCheckOutcome =
  | {
      readonly ok: true;
      readonly facts: CrosswordKernelFacts;
      readonly result: CrosswordKernelResult;
    }
  | CrosswordLiveFactFailure;

/**
 * Fail-closed composition: the exact-envelope adversarial validation runs
 * before the adapter and the accepted kernel runs only when adaptation
 * succeeded, so a disagreeing envelope can never reach the kernel.
 */
export function evaluateCrosswordLiveChecks(
  input: CrosswordLiveFactAdapterInput,
): CrosswordLiveCheckOutcome {
  const adaptation = adaptCrosswordLiveFacts(input);
  if (!adaptation.ok) return adaptation;
  const result = evaluateCrosswordChecks({
    profile: input.envelope.correctnessProfile as unknown as ResolvedCorrectnessProfile,
    route: input.route,
    actionCycle: input.actionCycle,
    facts: adaptation.facts,
  });
  return { ok: true, facts: adaptation.facts, result };
}
