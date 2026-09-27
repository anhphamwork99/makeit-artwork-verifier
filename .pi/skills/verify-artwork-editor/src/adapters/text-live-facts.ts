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
  evaluateOrdinaryTextChecks,
  evaluateWarpedTextChecks,
  isTextEvidenceAvailability,
  textCurrentnessForAuthority,
  type OrdinaryTextDeltaFact,
  type OrdinaryTextKernelFacts,
  type TextAuthorityState,
  type TextEvidenceFact,
  type TextKernelResult,
  type TextKernelVector,
  type WarpedTextCheckFact,
  type WarpedTextDeltaEvidenceFact,
  type WarpedTextEnvelopeEvidenceFact,
  type WarpedTextKernelFacts,
} from '../kernels/text-kernel';
import {
  MATERIALIZED_EXECUTION_ENVELOPE_SCHEMA_VERSION,
  type MaterializedExecutionEnvelopeV1,
} from '../planner/execution-materialization';

/**
 * P7-B2-B1 inactive live-fact adapters for ordinary and circle-warped Text
 * (ADR 0029 §4 B2-B).
 *
 * Each adapter sits between the delivered live runtime/Oracle observations and
 * the accepted inactive Text kernels. It receives exactly four things:
 *
 *  1. the exact `MaterializedExecutionEnvelopeV1` compiled once during planning;
 *  2. the route identity (Subject/Capability/variant) of the planned case;
 *  3. the Action Cycle correctness identity that observed the action; and
 *  4. the live observations/facts the delivered runtime already produced.
 *
 * It returns the structured kernel fact input for
 * `evaluateOrdinaryTextChecks`/`evaluateWarpedTextChecks`, or fails closed
 * *before* the kernel when the exact envelope, route, Action Cycle, or
 * observation is not in agreement.
 *
 * The adapters provide **facts only**. They own no required-check array, no
 * profile id or fallback id, no deadline/tolerance/visual/normalization
 * literal, no evidence-role default, no authoring-catalogue access, and no
 * Subject/family/scenario branch. They deliberately do not import any active
 * executor, Oracle, CLI, browser, writer, classifier, or catalogue module: the
 * live observations are consumed through structural contracts that the
 * delivered Oracle results already satisfy. The delivered Oracle's legacy
 * composite check-result booleans and its aggregate harness-validity flag are
 * never read: every structured authority/currentness/source-agreement/mismatch
 * fact is derived only from the Oracle's additive, explicitly named primitive
 * observations, and no boolean check result is translated into a final status
 * here.
 *
 * The module is entirely inactive: it is not re-exported from `src/index.ts`
 * and is referenced only by its focused foundation tests.
 */

/** Closed adapter issue vocabulary; deliberately local to the inactive adapter. */
export const TEXT_LIVE_FACT_ISSUE_CODES = [
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
  'TEXT_LIVE_OBSERVATION_MALFORMED',
  'TEXT_LIVE_OBSERVATION_PROFILE_MISMATCH',
  'TEXT_LIVE_EVIDENCE_FACT_INVALID',
] as const;
export type TextLiveFactIssueCode = (typeof TEXT_LIVE_FACT_ISSUE_CODES)[number];

const PRIMARY_DIAGNOSTIC_CODE: Readonly<Record<TextLiveFactIssueCode, DiagnosticCode>> =
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
    TEXT_LIVE_OBSERVATION_MALFORMED: 'UNUSABLE_EVIDENCE',
    TEXT_LIVE_OBSERVATION_PROFILE_MISMATCH: 'CORRECTNESS_REFERENCE_AMBIGUOUS',
    TEXT_LIVE_EVIDENCE_FACT_INVALID: 'UNUSABLE_EVIDENCE',
  } satisfies Record<TextLiveFactIssueCode, DiagnosticCode>);

export interface TextLiveFactIssue {
  readonly code: TextLiveFactIssueCode;
  readonly detail: string;
}

export interface TextLiveFactFailure {
  readonly ok: false;
  readonly status: 'HARNESS_BLOCKED';
  readonly launchAttempted: false;
  readonly code: DiagnosticCode;
  readonly diagnostic: DiagnosticRecord;
  readonly issues: readonly TextLiveFactIssue[];
}

export type TextLiveFactAdaptation<Facts> =
  | { readonly ok: true; readonly facts: Facts }
  | TextLiveFactFailure;

/** The route identity a planned case asked the adapter to evaluate. */
export interface TextLiveFactRoute {
  readonly subjectId: string;
  readonly capability: Capability;
  readonly variant: string | null;
}

/**
 * Structural projection of the accepted ordinary-Text `geometry.delta` Oracle
 * result (`GeometryDeltaOracleResult`). Every field is the delivered Oracle's
 * own fact; the adapter consumes the primitive predicate booleans
 * (`canonicalMet`, `renderedMet`, `sourcesAgree`) whose source deltas are
 * carried alongside them. The legacy composite result authority is
 * deliberately not read.
 */
export interface OrdinaryTextLiveDeltaObservation {
  readonly checkId: string;
  readonly canonicalDelta: TextKernelVector | null;
  readonly renderedDelta: TextKernelVector | null;
  readonly agreement: TextKernelVector | null;
  readonly canonicalMet: boolean;
  readonly renderedMet: boolean;
  readonly sourcesAgree: boolean;
  readonly detail: string;
}

/** Closed explicit authority vocabulary of the additive primitive facts. */
export const WARPED_LIVE_PRIMITIVE_AUTHORITIES = ['current', 'malformed'] as const;
export type WarpedLivePrimitiveAuthority = (typeof WARPED_LIVE_PRIMITIVE_AUTHORITIES)[number];

function isWarpedLivePrimitiveAuthority(value: unknown): value is WarpedLivePrimitiveAuthority {
  return (
    typeof value === 'string' &&
    (WARPED_LIVE_PRIMITIVE_AUTHORITIES as readonly string[]).includes(value)
  );
}

/**
 * One explicit per-check primitive predicate of the delivered warped-Text
 * Oracle evaluation. `predicateMet` is the Oracle's own per-check predicate
 * derived from raw measured observations against the applied tolerances; it is
 * not a legacy composite check-result boolean.
 */
export interface WarpedTextLivePrimitiveCheckObservation {
  readonly checkId: string;
  readonly predicateMet: boolean;
}

/**
 * The additive primitive facts of the delivered warped-Text Oracle evaluation
 * the adapter is allowed to read (ADR 0029 §4 B2-B): an explicit structured
 * authority, the independent canonical/renderer source-agreement primitives,
 * and one explicit per-check predicate. The delivered Oracle's legacy composite
 * check-result booleans and its aggregate harness-validity flag are deliberately
 * not part of this view.
 */
export interface WarpedTextLivePrimitiveFactsObservation {
  readonly authority: WarpedLivePrimitiveAuthority;
  readonly canonicalSourcesAgree: boolean;
  readonly rendererSourcesAgree: boolean;
  readonly checks: readonly WarpedTextLivePrimitiveCheckObservation[];
}

/**
 * Structural projection of the delivered warped-Text Oracle evaluation
 * (`WarpedOracleEvaluation`). The additive `primitiveFacts` view and the raw
 * `delta`/`envelope` source evidence are carried; the legacy aggregate
 * harness-validity flag and per-check boolean check results are not.
 */
export interface WarpedTextLiveEvaluationObservation {
  readonly profileId: string;
  readonly primitiveFacts: WarpedTextLivePrimitiveFactsObservation;
  readonly delta: WarpedTextDeltaEvidenceFact;
  readonly envelope: WarpedTextEnvelopeEvidenceFact;
}

export interface OrdinaryTextLiveFactAdapterInput {
  readonly envelope: MaterializedExecutionEnvelopeV1;
  readonly route: TextLiveFactRoute;
  readonly actionCycle: ActionCycleCorrectnessIdentity;
  /** The Case Intent's accepted minimum delta, or `null` when unusable. */
  readonly minimumDelta: TextKernelVector | null;
  /** The accepted `geometry.delta` result, or `null` when the Oracle never ran. */
  readonly delta: OrdinaryTextLiveDeltaObservation | null;
  /** The observed evidence roles; the adapter never invents a role. */
  readonly evidence: readonly TextEvidenceFact[];
}

export interface WarpedTextLiveFactAdapterInput {
  readonly envelope: MaterializedExecutionEnvelopeV1;
  readonly route: TextLiveFactRoute;
  readonly actionCycle: ActionCycleCorrectnessIdentity;
  readonly minimumDelta: TextKernelVector | null;
  /** The accepted warped-Text evaluation, or `null` when the Oracle never ran. */
  readonly oracle: WarpedTextLiveEvaluationObservation | null;
  readonly evidence: readonly TextEvidenceFact[];
}

interface FamilyContract {
  readonly oracleEvaluatorKind: string;
  readonly checkEvaluators: readonly string[];
}

const ORDINARY_FAMILY: FamilyContract = Object.freeze({
  oracleEvaluatorKind: 'geometry-delta',
  checkEvaluators: Object.freeze(['canonical-delta'] as const),
});

const WARPED_FAMILY: FamilyContract = Object.freeze({
  oracleEvaluatorKind: 'warped-text-envelope',
  checkEvaluators: Object.freeze(['typed-envelope'] as const),
});

function failure(issues: readonly TextLiveFactIssue[]): TextLiveFactFailure {
  const primary = issues[0] as TextLiveFactIssue;
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

function isVector(value: unknown): value is TextKernelVector {
  if (!isPlainRecord(value)) return false;
  return (
    typeof value.x === 'number' &&
    Number.isFinite(value.x) &&
    typeof value.y === 'number' &&
    Number.isFinite(value.y)
  );
}

function isEvidenceFactArray(value: unknown): value is readonly TextEvidenceFact[] {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        isPlainRecord(entry) &&
        typeof entry.evidenceId === 'string' &&
        isTextEvidenceAvailability(entry.availability),
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
  route: TextLiveFactRoute;
  actionCycle: ActionCycleCorrectnessIdentity;
  family: FamilyContract;
}): EnvelopeAgreement | TextLiveFactFailure {
  const issues: TextLiveFactIssue[] = [];
  const report = (code: TextLiveFactIssueCode, detail: string): void => {
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
      `profile capability ${String(profileView.capability)} ≠ requested ${input.route.capability}`,
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
      `Compiled Oracle evaluator "${String(oracleKind)}" is not supported by this Text adapter (expected "${input.family.oracleEvaluatorKind}").`,
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
        `Required check "${checkId}" declares evaluator "${String(contract.evaluator)}" which this Text adapter does not support.`,
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
 * Projects the accepted ordinary-Text Oracle result into explicit structured
 * kernel facts. The composite legacy result authority is not read:
 * authority is derived from whether the Oracle could read both positions, and
 * the product mismatch from the primitive predicates it did expose.
 */
export function projectOrdinaryTextLiveFact(
  observation: OrdinaryTextLiveDeltaObservation,
): OrdinaryTextDeltaFact {
  const unusable = observation.canonicalDelta === null || observation.renderedDelta === null;
  const authority: TextAuthorityState = unusable ? 'unavailable' : 'current';
  return {
    checkId: observation.checkId,
    authority,
    currentness: textCurrentnessForAuthority(authority),
    sourcesAgree: observation.sourcesAgree,
    mismatch: unusable
      ? false
      : !(observation.canonicalMet && observation.renderedMet && observation.sourcesAgree),
    canonicalDelta: isVector(observation.canonicalDelta) ? observation.canonicalDelta : null,
    renderedDelta: isVector(observation.renderedDelta) ? observation.renderedDelta : null,
    agreement: isVector(observation.agreement) ? observation.agreement : null,
    canonicalMet: observation.canonicalMet === true,
    renderedMet: observation.renderedMet === true,
    detail: typeof observation.detail === 'string' ? observation.detail : '',
  };
}

/**
 * Projects the delivered warped-Text Oracle evaluation into explicit structured
 * per-check kernel facts from its additive primitive observations only. The
 * explicit structured authority is read from the primitive authority state (not
 * from the legacy aggregate harness-validity flag); source agreement is the
 * conjunction of the independent canonical/renderer source-agreement
 * primitives; and the product mismatch is the negation of the check's own
 * explicitly named primitive predicate under a current authority. No legacy
 * composite boolean check result is read or translated.
 */
export function projectWarpedTextLiveFacts(
  observation: WarpedTextLiveEvaluationObservation,
): WarpedTextCheckFact[] {
  const primitive = observation.primitiveFacts;
  const authority: TextAuthorityState =
    primitive.authority === 'malformed' ? 'malformed' : 'current';
  const sourcesAgree =
    primitive.canonicalSourcesAgree === true && primitive.rendererSourcesAgree === true;
  return primitive.checks.map((check) => ({
    checkId: check.checkId,
    authority,
    currentness: textCurrentnessForAuthority(authority),
    sourcesAgree,
    mismatch: authority === 'malformed' ? false : check.predicateMet !== true,
  }));
}

function isOrdinaryObservation(value: unknown): value is OrdinaryTextLiveDeltaObservation {
  if (!isPlainRecord(value)) return false;
  return (
    typeof value.checkId === 'string' &&
    (value.canonicalDelta === null || isVector(value.canonicalDelta)) &&
    (value.renderedDelta === null || isVector(value.renderedDelta)) &&
    (value.agreement === null || isVector(value.agreement)) &&
    typeof value.canonicalMet === 'boolean' &&
    typeof value.renderedMet === 'boolean' &&
    typeof value.sourcesAgree === 'boolean' &&
    typeof value.detail === 'string'
  );
}

function isWarpedPrimitiveCheck(value: unknown): value is WarpedTextLivePrimitiveCheckObservation {
  return (
    isPlainRecord(value) &&
    typeof value.checkId === 'string' &&
    typeof value.predicateMet === 'boolean'
  );
}

function isWarpedPrimitiveFacts(value: unknown): value is WarpedTextLivePrimitiveFactsObservation {
  if (!isPlainRecord(value)) return false;
  if (!isWarpedLivePrimitiveAuthority(value.authority)) return false;
  if (typeof value.canonicalSourcesAgree !== 'boolean') return false;
  if (typeof value.rendererSourcesAgree !== 'boolean') return false;
  if (!Array.isArray(value.checks)) return false;
  return value.checks.every(isWarpedPrimitiveCheck);
}

function isWarpedObservation(value: unknown): value is WarpedTextLiveEvaluationObservation {
  if (!isPlainRecord(value)) return false;
  if (typeof value.profileId !== 'string') return false;
  if (!isWarpedPrimitiveFacts(value.primitiveFacts)) return false;
  return isPlainRecord(value.delta) && isPlainRecord(value.envelope);
}

/** Common pre-kernel checks shared by both Text adapters. */
function validateCommon(input: {
  envelope: MaterializedExecutionEnvelopeV1;
  route: TextLiveFactRoute;
  actionCycle: ActionCycleCorrectnessIdentity;
  family: FamilyContract;
  evidence: unknown;
}): EnvelopeAgreement | TextLiveFactFailure {
  if (!isEvidenceFactArray(input.evidence)) {
    return failure([
      {
        code: 'TEXT_LIVE_EVIDENCE_FACT_INVALID',
        detail:
          'Every observed evidence fact must carry a string evidenceId and a known availability; the adapter never invents an evidence role.',
      },
    ]);
  }
  return validateEnvelope(input);
}

/**
 * Adapts the delivered ordinary-Text live observations into the structured
 * kernel fact input, or fails closed before the kernel on any exact-envelope or
 * observation disagreement.
 */
export function adaptOrdinaryTextLiveFacts(
  input: OrdinaryTextLiveFactAdapterInput,
): TextLiveFactAdaptation<OrdinaryTextKernelFacts> {
  const agreement = validateCommon({
    envelope: input.envelope,
    route: input.route,
    actionCycle: input.actionCycle,
    family: ORDINARY_FAMILY,
    evidence: input.evidence,
  });
  if ('ok' in agreement) return agreement;

  if (input.delta !== null && !isOrdinaryObservation(input.delta)) {
    return failure([
      {
        code: 'TEXT_LIVE_OBSERVATION_MALFORMED',
        detail:
          'The ordinary-Text geometry.delta observation does not carry the accepted predicate/vector facts and cannot be interpreted.',
      },
    ]);
  }
  const check = input.delta === null ? null : projectOrdinaryTextLiveFact(input.delta);
  return {
    ok: true,
    facts: {
      evaluator: 'canonical-delta',
      minimumDelta: isVector(input.minimumDelta) ? input.minimumDelta : null,
      check,
      evidence: input.evidence,
    },
  };
}

/**
 * Adapts the delivered warped-Text live observation into the structured kernel
 * fact input, or fails closed before the kernel on any exact-envelope or
 * observation disagreement.
 */
export function adaptWarpedTextLiveFacts(
  input: WarpedTextLiveFactAdapterInput,
): TextLiveFactAdaptation<WarpedTextKernelFacts> {
  const agreement = validateCommon({
    envelope: input.envelope,
    route: input.route,
    actionCycle: input.actionCycle,
    family: WARPED_FAMILY,
    evidence: input.evidence,
  });
  if ('ok' in agreement) return agreement;

  if (input.oracle !== null && !isWarpedObservation(input.oracle)) {
    return failure([
      {
        code: 'TEXT_LIVE_OBSERVATION_MALFORMED',
        detail:
          'The warped-Text Oracle observation does not carry the accepted predicate/evidence facts and cannot be interpreted.',
      },
    ]);
  }
  if (
    input.oracle !== null &&
    input.oracle.profileId !== agreement.profile.oracle.oracleProfileId
  ) {
    return failure([
      {
        code: 'TEXT_LIVE_OBSERVATION_PROFILE_MISMATCH',
        detail: `The warped-Text observation was produced by Oracle profile "${input.oracle.profileId}" but the compiled profile resolves "${agreement.profile.oracle.oracleProfileId}".`,
      },
    ]);
  }
  return {
    ok: true,
    facts: {
      evaluator: 'typed-envelope',
      minimumDelta: isVector(input.minimumDelta) ? input.minimumDelta : null,
      checks: input.oracle === null ? [] : projectWarpedTextLiveFacts(input.oracle),
      delta: input.oracle === null ? null : input.oracle.delta,
      envelope: input.oracle === null ? null : input.oracle.envelope,
      evidence: input.evidence,
    },
  };
}

export type OrdinaryTextLiveCheckOutcome =
  | {
      readonly ok: true;
      readonly facts: OrdinaryTextKernelFacts;
      readonly result: TextKernelResult;
    }
  | TextLiveFactFailure;

export type WarpedTextLiveCheckOutcome =
  | {
      readonly ok: true;
      readonly facts: WarpedTextKernelFacts;
      readonly result: TextKernelResult;
    }
  | TextLiveFactFailure;

/**
 * Fail-closed composition: the exact-envelope adversarial validation runs
 * before the adapter and the accepted kernel runs only when adaptation
 * succeeded, so a disagreeing envelope can never reach the kernel.
 */
export function evaluateOrdinaryTextLiveChecks(
  input: OrdinaryTextLiveFactAdapterInput,
): OrdinaryTextLiveCheckOutcome {
  const adaptation = adaptOrdinaryTextLiveFacts(input);
  if (!adaptation.ok) return adaptation;
  const result = evaluateOrdinaryTextChecks({
    profile: input.envelope.correctnessProfile as unknown as ResolvedCorrectnessProfile,
    route: input.route,
    actionCycle: input.actionCycle,
    facts: adaptation.facts,
  });
  return { ok: true, facts: adaptation.facts, result };
}

export function evaluateWarpedTextLiveChecks(
  input: WarpedTextLiveFactAdapterInput,
): WarpedTextLiveCheckOutcome {
  const adaptation = adaptWarpedTextLiveFacts(input);
  if (!adaptation.ok) return adaptation;
  const result = evaluateWarpedTextChecks({
    profile: input.envelope.correctnessProfile as unknown as ResolvedCorrectnessProfile,
    route: input.route,
    actionCycle: input.actionCycle,
    facts: adaptation.facts,
  });
  return { ok: true, facts: adaptation.facts, result };
}
