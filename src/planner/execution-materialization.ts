import {
  deriveCapabilityBaselineFingerprint,
  deriveCaptureFingerprint,
  deriveNormalizationFingerprint,
  deriveOracleFingerprint,
  deriveReadinessFingerprint,
  deriveRequiredCheckSetFingerprint,
  deriveResolvedCorrectnessProfileFingerprint,
  deriveSubjectAdditionFingerprint,
  deriveToleranceFingerprint,
  deriveVisualAuthorityFingerprint,
} from '../catalogue/correctness';
import { IDENTITY_DOMAINS, identityDigest } from '../canonical/canonicalize';
import { deriveMaterializationFingerprint, derivePlanFingerprint } from '../canonical/identity';
import type { ExecutionPlan, MaterializedCase } from '../contracts/case-model';
import {
  isCheckEvaluator,
  isFullCanonicalFingerprint,
  isOracleEvaluatorKind,
  type CheckEvaluator,
  type CorrectnessReferenceEntry,
  type NormalizationDeclaration,
  type OracleEvaluatorKind,
  type ResolvedCheckContract,
  type ResolvedCorrectnessProfile,
  type ToleranceDeclaration,
  type VisualAuthorityDeclaration,
} from '../contracts/correctness';
import {
  createDiagnostic,
  type DiagnosticCode,
  type DiagnosticRecord,
} from '../contracts/diagnostics';
import { isPlainRecord } from '../contracts/result-agreement';
import { RESOLVED_CORRECTNESS_PROFILE_SCHEMA_VERSION } from '../contracts/schema-versions';
import { resolveOracleProfile } from '../oracles/profile-registry';
import { resolveReadinessProfile } from '../readiness/profile-registry';

/**
 * Internal compile-once execution materialization (ADR 0029 §2/§3, P7-B2-A).
 *
 * `planCase()` compiles the complete `ResolvedCorrectnessProfile` but retains
 * only `{profileId,resolvedFingerprint}` in the public `ExecutionPlan`. The
 * current final route kernels require the complete profile plus live evaluator
 * facts, so the exact compiled profile is carried through this **internal,
 * non-public** sidecar envelope rather than being embedded in the public plan
 * (which would move the accepted plan identity).
 *
 * The envelope is created in the same planner invocation that compiles the
 * public plan, deep-isolated from the mutable planning result, deeply frozen,
 * and handed onward by object reference. It is deliberately not a process-global
 * cache: nothing here is keyed by `profileId`, read from disk, or resolved
 * through a catalogue during execution. Validation is pre-allocation and fails
 * closed with `launchAttempted:false`, so a malformed or disagreeing envelope
 * can never produce a child result.
 *
 * This module is the current exact-materialization planner: it is imported by
 * `src/planner/plan-case.ts` and the current Diagnostic orchestration, and it is
 * not re-exported from `src/index.ts`. It resolves no profile from disk and
 * reads no catalogue during execution.
 */

/** Schema version of the internal execution materialization envelope. */
export const MATERIALIZED_EXECUTION_ENVELOPE_SCHEMA_VERSION = 1;

/** Recursive readonly projection used for the exact frozen envelope content. */
export type DeepReadonly<T> = T extends readonly (infer U)[]
  ? readonly DeepReadonly<U>[]
  : T extends object
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T;

/**
 * Internal exact-profile execution materialization envelope (ADR 0029 §2).
 *
 * It is keyed by the exact `planFingerprint` and carries the complete compiled
 * profile, deeply isolated and frozen. It is never part of a public plan, never
 * exported from `src/index.ts`, and never serialized as a plan artifact.
 */
export interface MaterializedExecutionEnvelopeV1 {
  schemaVersion: typeof MATERIALIZED_EXECUTION_ENVELOPE_SCHEMA_VERSION;
  caseId: string;
  materializationFingerprint: string;
  planFingerprint: string;
  plan: DeepReadonly<ExecutionPlan>;
  correctnessProfile: DeepReadonly<ResolvedCorrectnessProfile>;
}

/**
 * Closed evaluator → check dispatch for the current final kernel families
 * (ADR 0028 §3 B1-B–B1-F). It mirrors the delivered kernels' supported-check
 * sets exactly; it is a compatibility projection, not a policy authority.
 */
export const FINAL_EVALUATOR_DISPATCH: Readonly<
  Record<OracleEvaluatorKind, readonly CheckEvaluator[]>
> = Object.freeze({
  'geometry-delta': Object.freeze(['canonical-delta'] as const),
  'warped-text-envelope': Object.freeze(['typed-envelope'] as const),
  'nested-object-affine': Object.freeze(['nested-object-affine'] as const),
  'image-upload-replace': Object.freeze(['image-structural', 'renderer-transform'] as const),
  'crossword-determinism': Object.freeze(['crossword-determinism'] as const),
  'history-cross-subject': Object.freeze(['history-cross-subject'] as const),
  'frontend-restore': Object.freeze(['frontend-restore'] as const),
});

/** Thrown when a value cannot be canonically isolated into the envelope. */
export class MaterializedExecutionIsolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MaterializedExecutionIsolationError';
  }
}

function isPlainIsolatableObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}

/**
 * Deep clone and deep freeze one planning value so the envelope owns an
 * isolated, immutable copy. Non-plain objects, `undefined`, non-finite numbers,
 * functions, symbols, and bigints are rejected: an envelope must be a closed,
 * canonically fingerprintable value, never a live planning reference.
 */
function isolateFrozen(value: unknown, path: string): unknown {
  if (value === null) return null;
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return value;
    case 'number':
      if (!Number.isFinite(value)) {
        throw new MaterializedExecutionIsolationError(
          `Non-finite number is not isolatable at ${path}`,
        );
      }
      return value;
    case 'object':
      break;
    default:
      throw new MaterializedExecutionIsolationError(
        `Unsupported envelope value type "${typeof value}" at ${path}`,
      );
  }

  if (Array.isArray(value)) {
    return Object.freeze(value.map((entry, index) => isolateFrozen(entry, `${path}[${index}]`)));
  }
  if (!isPlainIsolatableObject(value)) {
    throw new MaterializedExecutionIsolationError(`Non-plain object is not isolatable at ${path}`);
  }
  const source = value as Record<string, unknown>;
  const clone: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    clone[key] = isolateFrozen(source[key], `${path}.${key}`);
  }
  return Object.freeze(clone);
}

export interface CreateMaterializedExecutionEnvelopeInput {
  caseId: string;
  materializationFingerprint: string;
  planFingerprint: string;
  /** The exact public plan compiled in the same planning invocation. */
  plan: ExecutionPlan;
  /** The exact profile compiled once in the same planning invocation. */
  correctnessProfile: ResolvedCorrectnessProfile;
}

/**
 * Creates the exact compile-once envelope from the already-compiled public plan
 * and profile. It never compiles a profile, loads a catalogue, or consults a
 * cache; it only isolates and freezes the values it was handed.
 */
export function createMaterializedExecutionEnvelope(
  input: CreateMaterializedExecutionEnvelopeInput,
): MaterializedExecutionEnvelopeV1 {
  return Object.freeze({
    schemaVersion: MATERIALIZED_EXECUTION_ENVELOPE_SCHEMA_VERSION,
    caseId: input.caseId,
    materializationFingerprint: input.materializationFingerprint,
    planFingerprint: input.planFingerprint,
    plan: isolateFrozen(input.plan, 'plan') as DeepReadonly<ExecutionPlan>,
    correctnessProfile: isolateFrozen(
      input.correctnessProfile,
      'correctnessProfile',
    ) as DeepReadonly<ResolvedCorrectnessProfile>,
  });
}

/**
 * Closed pre-allocation envelope agreement issue vocabulary (ADR 0029 §3). The
 * issue code is the precise failing agreement check; the primary diagnostic
 * reuses the existing blocking correctness vocabulary.
 */
export const MATERIALIZED_EXECUTION_ISSUE_CODES = [
  'ENVELOPE_SCHEMA_UNSUPPORTED',
  'ENVELOPE_PLAN_FINGERPRINT_INVALID',
  'ENVELOPE_PLAN_FINGERPRINT_MISMATCH',
  'ENVELOPE_CASE_ID_MISMATCH',
  'ENVELOPE_MATERIALIZATION_IDENTITY_MISMATCH',
  'ENVELOPE_PROFILE_MISSING',
  'ENVELOPE_PROFILE_SCHEMA_UNSUPPORTED',
  'ENVELOPE_PROFILE_FINGERPRINT_INVALID',
  'ENVELOPE_PROFILE_FINGERPRINT_MISMATCH',
  'ENVELOPE_PROFILE_AGREEMENT_MISMATCH',
  'ENVELOPE_MATERIALIZED_PROFILE_MISMATCH',
  'ENVELOPE_ROUTE_MISMATCH',
  'ENVELOPE_REQUIRED_CHECK_DRIFT',
  'ENVELOPE_COMPONENT_FINGERPRINT_INVALID',
  'ENVELOPE_COMPONENT_FINGERPRINT_MISMATCH',
  'ENVELOPE_REFERENCE_CLOSURE_INCOMPLETE',
  'ENVELOPE_NON_WEAKENING_VIOLATION',
  'ENVELOPE_EVALUATOR_UNSUPPORTED',
] as const;
export type MaterializedExecutionIssueCode = (typeof MATERIALIZED_EXECUTION_ISSUE_CODES)[number];

export interface MaterializedExecutionIssue {
  code: MaterializedExecutionIssueCode;
  detail: string;
}

const PRIMARY_DIAGNOSTIC_CODE: Readonly<Record<MaterializedExecutionIssueCode, DiagnosticCode>> =
  Object.freeze({
    ENVELOPE_SCHEMA_UNSUPPORTED: 'CORRECTNESS_CATALOGUE_SCHEMA_UNSUPPORTED',
    ENVELOPE_PLAN_FINGERPRINT_INVALID: 'CORRECTNESS_COMPATIBILITY_DIVERGENCE',
    ENVELOPE_PLAN_FINGERPRINT_MISMATCH: 'CORRECTNESS_COMPATIBILITY_DIVERGENCE',
    ENVELOPE_CASE_ID_MISMATCH: 'CORRECTNESS_COMPATIBILITY_DIVERGENCE',
    ENVELOPE_MATERIALIZATION_IDENTITY_MISMATCH: 'CORRECTNESS_COMPATIBILITY_DIVERGENCE',
    ENVELOPE_PROFILE_MISSING: 'CORRECTNESS_PROFILE_MISSING',
    ENVELOPE_PROFILE_SCHEMA_UNSUPPORTED: 'CORRECTNESS_CATALOGUE_SCHEMA_UNSUPPORTED',
    ENVELOPE_PROFILE_FINGERPRINT_INVALID: 'CORRECTNESS_COMPATIBILITY_DIVERGENCE',
    ENVELOPE_PROFILE_FINGERPRINT_MISMATCH: 'CORRECTNESS_COMPATIBILITY_DIVERGENCE',
    ENVELOPE_PROFILE_AGREEMENT_MISMATCH: 'CORRECTNESS_COMPATIBILITY_DIVERGENCE',
    ENVELOPE_MATERIALIZED_PROFILE_MISMATCH: 'CORRECTNESS_COMPATIBILITY_DIVERGENCE',
    ENVELOPE_ROUTE_MISMATCH: 'CORRECTNESS_REFERENCE_AMBIGUOUS',
    ENVELOPE_REQUIRED_CHECK_DRIFT: 'CORRECTNESS_REFERENCE_UNRESOLVED',
    ENVELOPE_COMPONENT_FINGERPRINT_INVALID: 'CORRECTNESS_COMPATIBILITY_DIVERGENCE',
    ENVELOPE_COMPONENT_FINGERPRINT_MISMATCH: 'CORRECTNESS_COMPATIBILITY_DIVERGENCE',
    ENVELOPE_REFERENCE_CLOSURE_INCOMPLETE: 'CORRECTNESS_REFERENCE_UNRESOLVED',
    ENVELOPE_NON_WEAKENING_VIOLATION: 'CORRECTNESS_NON_WEAKENING_VIOLATION',
    ENVELOPE_EVALUATOR_UNSUPPORTED: 'CORRECTNESS_UNKNOWN_DISCRIMINANT',
  } satisfies Record<MaterializedExecutionIssueCode, DiagnosticCode>);

export interface ValidateMaterializedExecutionInput {
  envelope: MaterializedExecutionEnvelopeV1;
  /** The exact materialized case produced by the same planning invocation. */
  materializedCase: DeepReadonly<MaterializedCase>;
}

export type MaterializedExecutionValidation =
  | { ok: true }
  | {
      ok: false;
      status: 'HARNESS_BLOCKED';
      launchAttempted: false;
      code: DiagnosticCode;
      diagnostic: DiagnosticRecord;
      issues: readonly MaterializedExecutionIssue[];
    };

type DerivationResult = { ok: true; value: string } | { ok: false; detail: string };

function tryDerive(derive: () => string): DerivationResult {
  try {
    return { ok: true, value: derive() };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

function label(values: readonly string[]): string {
  return `[${values.join(', ')}]`;
}

const COMPONENT_FINGERPRINT_FIELDS = [
  'readiness',
  'capture',
  'oracle',
  'capabilityBaseline',
  'subjectAddition',
  'requiredCheckSet',
  'tolerances',
  'visuals',
  'normalization',
] as const;

/**
 * Recomputes every compiled component fingerprint from the profile content
 * alone. This is the component-level half of the profile-fingerprint agreement
 * check: a mutated component cannot keep a stale component fingerprint, and no
 * authoring catalogue is consulted.
 */
/** The declaration-only projection of an applicable resolved normalization. */
function normalizationDeclarationOf(
  normalization: ResolvedCorrectnessProfile['normalization'] & { applicable: true },
): NormalizationDeclaration {
  return {
    normalizationId: normalization.normalizationId,
    version: normalization.version,
    applicability: normalization.applicability,
    meaningRef: normalization.meaningRef,
    evaluator: normalization.evaluator,
  };
}

function recomputeComponentFingerprints(
  profile: ResolvedCorrectnessProfile,
): Record<string, string> {
  const requiredChecks = asArray(profile.requiredChecks) as ResolvedCheckContract[];
  const tolerances = asArray(profile.tolerances) as ToleranceDeclaration[];
  const visuals = asArray(profile.visuals) as VisualAuthorityDeclaration[];
  const normalization = profile.normalization;
  return {
    readiness: deriveReadinessFingerprint(profile.readiness),
    capture: deriveCaptureFingerprint(profile.capture),
    oracle: deriveOracleFingerprint(profile.oracle),
    capabilityBaseline: deriveCapabilityBaselineFingerprint(profile.capabilityBaseline),
    subjectAddition: deriveSubjectAdditionFingerprint(profile.subjectAddition),
    requiredCheckSet: deriveRequiredCheckSetFingerprint(requiredChecks),
    tolerances: identityDigest(
      IDENTITY_DOMAINS.toleranceDeclaration,
      tolerances.map((entry) => deriveToleranceFingerprint(entry)),
    ),
    visuals: identityDigest(
      IDENTITY_DOMAINS.visualAuthority,
      visuals.map((entry) => deriveVisualAuthorityFingerprint(entry)),
    ),
    normalization:
      normalization.applicable === true
        ? deriveNormalizationFingerprint(normalizationDeclarationOf(normalization))
        : identityDigest(IDENTITY_DOMAINS.normalizationDeclaration, { profile: 'not-applicable' }),
  };
}

/**
 * Reconstructs the exact reference closure the compiler must have emitted from
 * the profile content alone, so a missing, extra, or duplicated closure edge is
 * a failure rather than a silently tolerated omission.
 */
function expectedReferenceClosure(
  profile: ResolvedCorrectnessProfile,
): CorrectnessReferenceEntry[] {
  const requiredChecks = asArray(profile.requiredChecks) as ResolvedCheckContract[];
  const tolerances = asArray(profile.tolerances) as ToleranceDeclaration[];
  const visuals = asArray(profile.visuals) as VisualAuthorityDeclaration[];
  const normalization = profile.normalization;
  return [
    { kind: 'readiness', id: profile.readiness.profileId },
    { kind: 'capture', id: profile.capture.captureProfileId },
    { kind: 'oracle', id: profile.oracle.oracleProfileId },
    { kind: 'capability-baseline', id: profile.capabilityBaseline.capability },
    {
      kind: 'subject-addition',
      id: `${profile.subjectAddition.subjectId}×${profile.subjectAddition.capability}`,
    },
    ...requiredChecks.map((entry) => ({ kind: 'required-check', id: entry.checkId })),
    ...asArray(profile.requiredAuthoritativeEvidence).map((entry) => ({
      kind: 'required-authoritative-evidence',
      id: String(entry),
    })),
    ...asArray(profile.diagnosticOnlyEvidence).map((entry) => ({
      kind: 'diagnostic-only-evidence',
      id: String(entry),
    })),
    ...tolerances.map((entry) => ({ kind: 'tolerance', id: entry.toleranceId })),
    ...visuals.map((entry) => ({ kind: 'visual-authority', id: entry.visualId })),
    normalization.applicable === true
      ? { kind: 'normalization', id: normalization.normalizationId }
      : { kind: 'normalization', id: 'not-applicable' },
  ];
}

function closureKey(entry: CorrectnessReferenceEntry): string {
  return `${entry.kind}\u0000${entry.id}`;
}

function failure(issues: readonly MaterializedExecutionIssue[]): MaterializedExecutionValidation {
  const primary = issues[0] as MaterializedExecutionIssue;
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

/**
 * Mandatory pre-allocation envelope agreement validation (ADR 0029 §3).
 *
 * It recomputes the plan, materialization, profile, per-component, closure, and
 * non-weakening facts from the envelope and the materialized case, and checks
 * every cross-artifact agreement. Any failure is `HARNESS_BLOCKED` with
 * `launchAttempted:false` so no child result can be written. It performs no
 * catalogue, disk, or global-cache lookup.
 */
export function validateMaterializedExecutionEnvelope(
  input: ValidateMaterializedExecutionInput,
): MaterializedExecutionValidation {
  const issues: MaterializedExecutionIssue[] = [];
  const report = (code: MaterializedExecutionIssueCode, detail: string): void => {
    issues.push({ code, detail });
  };

  const envelope = input.envelope as unknown as Record<string, unknown>;
  if (!isPlainRecord(envelope)) {
    report('ENVELOPE_SCHEMA_UNSUPPORTED', 'An execution envelope must be a plain object.');
    return failure(issues);
  }
  if (envelope.schemaVersion !== MATERIALIZED_EXECUTION_ENVELOPE_SCHEMA_VERSION) {
    report(
      'ENVELOPE_SCHEMA_UNSUPPORTED',
      `Execution envelope schema ${String(envelope.schemaVersion)} is not supported.`,
    );
  }

  const plan = envelope.plan;
  const profile = envelope.correctnessProfile;
  if (!isPlainRecord(plan)) {
    report('ENVELOPE_PLAN_FINGERPRINT_INVALID', 'The envelope carries no readable public plan.');
  }
  if (!isPlainRecord(profile)) {
    report(
      'ENVELOPE_PROFILE_MISSING',
      'The envelope carries no readable resolved correctness profile.',
    );
  }
  if (issues.length > 0) return failure(issues);

  const planView = plan as unknown as ExecutionPlan;
  const profileView = profile as unknown as ResolvedCorrectnessProfile;
  const caseView = input.materializedCase as unknown as MaterializedCase;

  // 1–2. Envelope schema and recomputed plan fingerprint.
  if (!isFullCanonicalFingerprint(envelope.planFingerprint)) {
    report(
      'ENVELOPE_PLAN_FINGERPRINT_INVALID',
      `Envelope plan fingerprint "${String(envelope.planFingerprint)}" is not a full canonical 64-hex identity.`,
    );
  }
  const planFingerprint = tryDerive(() => derivePlanFingerprint(planView));
  if (!planFingerprint.ok) {
    report(
      'ENVELOPE_PLAN_FINGERPRINT_INVALID',
      `The plan is not canonically fingerprintable: ${planFingerprint.detail}`,
    );
  } else if (planFingerprint.value !== envelope.planFingerprint) {
    report(
      'ENVELOPE_PLAN_FINGERPRINT_MISMATCH',
      `Recomputed plan fingerprint ${planFingerprint.value} does not equal the envelope plan fingerprint ${String(envelope.planFingerprint)}.`,
    );
  }

  // 3–4. Case and materialization identity agreement with the envelope.
  if (planView.caseId !== envelope.caseId) {
    report(
      'ENVELOPE_CASE_ID_MISMATCH',
      `Plan case id ${String(planView.caseId)} does not equal the envelope case id ${String(envelope.caseId)}.`,
    );
  }
  if (caseView.caseId !== envelope.caseId) {
    report(
      'ENVELOPE_CASE_ID_MISMATCH',
      `Materialized case id ${String(caseView.caseId)} does not equal the envelope case id ${String(envelope.caseId)}.`,
    );
  }
  if (!isFullCanonicalFingerprint(envelope.materializationFingerprint)) {
    report(
      'ENVELOPE_MATERIALIZATION_IDENTITY_MISMATCH',
      `Envelope materialization fingerprint "${String(envelope.materializationFingerprint)}" is not a full canonical 64-hex identity.`,
    );
  }
  const materializationFingerprint = tryDerive(() => deriveMaterializationFingerprint(caseView));
  if (!materializationFingerprint.ok) {
    report(
      'ENVELOPE_MATERIALIZATION_IDENTITY_MISMATCH',
      `The materialized case is not canonically fingerprintable: ${materializationFingerprint.detail}`,
    );
  } else if (materializationFingerprint.value !== envelope.materializationFingerprint) {
    report(
      'ENVELOPE_MATERIALIZATION_IDENTITY_MISMATCH',
      `Recomputed materialization fingerprint ${materializationFingerprint.value} does not equal the envelope materialization fingerprint ${String(envelope.materializationFingerprint)}.`,
    );
  }

  // 5. Profile schema support.
  if (profileView.schemaVersion !== RESOLVED_CORRECTNESS_PROFILE_SCHEMA_VERSION) {
    report(
      'ENVELOPE_PROFILE_SCHEMA_UNSUPPORTED',
      `Resolved-profile schema ${String(profileView.schemaVersion)} is not supported.`,
    );
  }

  // 6. Recomputed profile fingerprint.
  const storedResolvedFingerprint = profileView.resolvedFingerprint;
  if (!isFullCanonicalFingerprint(storedResolvedFingerprint)) {
    report(
      'ENVELOPE_PROFILE_FINGERPRINT_INVALID',
      `Resolved-profile fingerprint "${String(storedResolvedFingerprint)}" is not a full canonical 64-hex identity.`,
    );
  }
  const { resolvedFingerprint: _storedFingerprint, ...profileContent } = profileView;
  const recomputedProfileFingerprint = tryDerive(() =>
    deriveResolvedCorrectnessProfileFingerprint(profileContent),
  );
  if (!recomputedProfileFingerprint.ok) {
    report(
      'ENVELOPE_PROFILE_FINGERPRINT_INVALID',
      `The resolved profile is not canonically fingerprintable: ${recomputedProfileFingerprint.detail}`,
    );
  } else if (recomputedProfileFingerprint.value !== storedResolvedFingerprint) {
    report(
      'ENVELOPE_PROFILE_FINGERPRINT_MISMATCH',
      `Recomputed resolved-profile fingerprint ${recomputedProfileFingerprint.value} does not equal the stored fingerprint ${String(storedResolvedFingerprint)}; a compiled field was mutated.`,
    );
  }

  // 7–10. Plan / materialized-contract / profile identity agreement.
  const planCorrectness: unknown = planView.correctness;
  if (!isPlainRecord(planCorrectness)) {
    report(
      'ENVELOPE_PROFILE_AGREEMENT_MISMATCH',
      'The plan carries no readable correctness projection identity.',
    );
  } else {
    if (planCorrectness.resolvedFingerprint !== storedResolvedFingerprint) {
      report(
        'ENVELOPE_PROFILE_AGREEMENT_MISMATCH',
        `Plan correctness fingerprint ${String(planCorrectness.resolvedFingerprint)} does not equal the resolved-profile fingerprint ${String(storedResolvedFingerprint)}.`,
      );
    }
    if (
      typeof planCorrectness.profileId !== 'string' ||
      planCorrectness.profileId === null ||
      planCorrectness.profileId !== profileView.profileId
    ) {
      report(
        'ENVELOPE_PROFILE_AGREEMENT_MISMATCH',
        `Plan correctness profile id ${String(planCorrectness.profileId)} does not equal the resolved-profile id ${String(profileView.profileId)}.`,
      );
    }
  }
  const contracts: unknown = caseView.contracts;
  if (!isPlainRecord(contracts)) {
    report(
      'ENVELOPE_MATERIALIZED_PROFILE_MISMATCH',
      'The materialized case carries no readable resolved contracts.',
    );
  } else if (contracts.correctnessProfileFingerprint !== storedResolvedFingerprint) {
    report(
      'ENVELOPE_MATERIALIZED_PROFILE_MISMATCH',
      `Materialized contract correctness fingerprint ${String(contracts.correctnessProfileFingerprint)} does not equal the resolved-profile fingerprint ${String(storedResolvedFingerprint)}.`,
    );
  }

  // 11. Route Subject / Capability / variant agreement.
  const route: unknown = planView.route;
  const intent: unknown = caseView.intent;
  const subject: unknown = caseView.subject;
  if (
    !isPlainRecord(route) ||
    !isPlainRecord(intent) ||
    !isPlainRecord(subject) ||
    !isPlainRecord(caseView.route)
  ) {
    report('ENVELOPE_ROUTE_MISMATCH', 'The plan or materialized case carries no readable route.');
  } else {
    const materializedRoute = caseView.route as unknown as Record<string, unknown>;
    const routeMismatches: string[] = [];
    if (profileView.subjectId !== route.subjectId) {
      routeMismatches.push(
        `profile subject ${String(profileView.subjectId)} ≠ plan ${String(route.subjectId)}`,
      );
    }
    if (route.subjectId !== subject.subjectId) {
      routeMismatches.push(
        `plan subject ${String(route.subjectId)} ≠ materialized ${String(subject.subjectId)}`,
      );
    }
    if (route.subjectId !== materializedRoute.subjectId) {
      routeMismatches.push(
        `plan subject ${String(route.subjectId)} ≠ materialized route ${String(materializedRoute.subjectId)}`,
      );
    }
    if (profileView.capability !== route.capability) {
      routeMismatches.push(
        `profile capability ${String(profileView.capability)} ≠ plan ${String(route.capability)}`,
      );
    }
    if (profileView.capability !== intent.capability) {
      routeMismatches.push(
        `profile capability ${String(profileView.capability)} ≠ intent ${String(intent.capability)}`,
      );
    }
    if (route.capability !== materializedRoute.capability) {
      routeMismatches.push(
        `plan capability ${String(route.capability)} ≠ materialized route ${String(materializedRoute.capability)}`,
      );
    }
    if (profileView.variant !== intent.variant) {
      routeMismatches.push(
        `profile variant ${String(profileView.variant)} ≠ intent ${String(intent.variant)}`,
      );
    }
    if (route.adapterId !== materializedRoute.adapterId) {
      routeMismatches.push(
        `plan adapter ${String(route.adapterId)} ≠ materialized ${String(materializedRoute.adapterId)}`,
      );
    }
    if (route.workflowId !== materializedRoute.workflowId) {
      routeMismatches.push(
        `plan workflow ${String(route.workflowId)} ≠ materialized ${String(materializedRoute.workflowId)}`,
      );
    }
    if (route.adapterCompatibilityVersion !== materializedRoute.adapterCompatibilityVersion) {
      routeMismatches.push('plan adapter compatibility version ≠ materialized');
    }
    if (routeMismatches.length > 0) {
      report('ENVELOPE_ROUTE_MISMATCH', routeMismatches.join('; '));
    }
  }

  // 12. Exact required-check agreement between plan and compiled profile.
  const profileCheckIds = asArray(profileView.requiredChecks).map((entry) => {
    const check = entry as { checkId?: unknown };
    return typeof check.checkId === 'string' ? check.checkId : '';
  });
  if (profileCheckIds.some((entry) => entry.length === 0)) {
    report('ENVELOPE_REQUIRED_CHECK_DRIFT', 'A compiled required check has no check id.');
  }
  if (new Set(profileCheckIds).size !== profileCheckIds.length) {
    report('ENVELOPE_REQUIRED_CHECK_DRIFT', 'A compiled required check id appears more than once.');
  }
  const planCheckIds = asArray(planView.requiredChecks).map((entry) => String(entry));
  const sortedPlanChecks = [...planCheckIds].sort();
  const sortedProfileChecks = [...profileCheckIds].sort();
  if (!sameStringArray(sortedPlanChecks, sortedProfileChecks)) {
    report(
      'ENVELOPE_REQUIRED_CHECK_DRIFT',
      `Plan required checks ${label(sortedPlanChecks)} do not exactly equal the compiled profile required checks ${label(sortedProfileChecks)}.`,
    );
  }

  // 13. Complete canonical 64-hex component fingerprints.
  const components: unknown = profileView.componentFingerprints;
  if (!isPlainRecord(components)) {
    report(
      'ENVELOPE_COMPONENT_FINGERPRINT_INVALID',
      'The compiled profile carries no component fingerprints.',
    );
  } else {
    for (const field of COMPONENT_FINGERPRINT_FIELDS) {
      if (!isFullCanonicalFingerprint(components[field])) {
        report(
          'ENVELOPE_COMPONENT_FINGERPRINT_INVALID',
          `Compiled component fingerprint "${field}" is not a full canonical 64-hex identity.`,
        );
      }
    }
    let recomputed: Record<string, string> | null = null;
    try {
      recomputed = recomputeComponentFingerprints(profileView);
    } catch (error) {
      report(
        'ENVELOPE_COMPONENT_FINGERPRINT_MISMATCH',
        `Component fingerprints could not be recomputed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (recomputed !== null) {
      for (const field of COMPONENT_FINGERPRINT_FIELDS) {
        const expected = recomputed[field];
        if (expected !== undefined && components[field] !== expected) {
          report(
            'ENVELOPE_COMPONENT_FINGERPRINT_MISMATCH',
            `Component fingerprint "${field}" ${String(components[field])} does not equal the recomputed ${expected}.`,
          );
        }
      }
    }
  }

  // 14. Complete exact reference closure.
  let expectedClosureKeys: string[] = [];
  try {
    expectedClosureKeys = expectedReferenceClosure(profileView).map(closureKey).sort();
  } catch (error) {
    report(
      'ENVELOPE_REFERENCE_CLOSURE_INCOMPLETE',
      `The reference closure could not be reconstructed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const actualClosureKeys = asArray(profileView.referenceClosure).map((entry) => {
    const value = entry as { kind?: unknown; id?: unknown };
    return `${String(value.kind)}\u0000${String(value.id)}`;
  });
  for (const key of expectedClosureKeys) {
    if (!actualClosureKeys.includes(key)) {
      report(
        'ENVELOPE_REFERENCE_CLOSURE_INCOMPLETE',
        `Reference closure is missing ${key.replace('\u0000', ':')}.`,
      );
    }
  }
  for (const key of actualClosureKeys) {
    if (!expectedClosureKeys.includes(key)) {
      report(
        'ENVELOPE_REFERENCE_CLOSURE_INCOMPLETE',
        `Reference closure carries an unexpected edge ${key.replace('\u0000', ':')}.`,
      );
    }
  }
  if (new Set(actualClosureKeys).size !== actualClosureKeys.length) {
    report('ENVELOPE_REFERENCE_CLOSURE_INCOMPLETE', 'Reference closure carries a duplicate edge.');
  }

  // 15. Non-weakening assertions and structural retention invariants.
  const nonWeakening = asArray(profileView.nonWeakening);
  if (nonWeakening.length === 0) {
    report(
      'ENVELOPE_NON_WEAKENING_VIOLATION',
      'The compiled profile records no non-weakening assertion.',
    );
  }
  for (const entry of nonWeakening) {
    const assertion = entry as { requirement?: unknown; satisfied?: unknown };
    if (assertion.satisfied !== true) {
      report(
        'ENVELOPE_NON_WEAKENING_VIOLATION',
        `Non-weakening assertion "${String(assertion.requirement)}" is not satisfied.`,
      );
    }
  }
  const oracle = profileView.oracle as unknown as Record<string, unknown>;
  const oracleCheckIds = asArray(oracle?.checks).map((entry) => {
    const check = entry as { checkId?: unknown };
    return typeof check.checkId === 'string' ? check.checkId : '';
  });
  if (!sameStringArray([...oracleCheckIds].sort(), sortedProfileChecks)) {
    report(
      'ENVELOPE_NON_WEAKENING_VIOLATION',
      `Oracle definitions ${label([...oracleCheckIds].sort())} do not exactly cover the composed required checks ${label(sortedProfileChecks)}.`,
    );
  }
  const baselineChecks = asArray(profileView.capabilityBaseline?.checks).map((entry) =>
    String(entry),
  );
  const additionChecks = asArray(profileView.subjectAddition?.checks).map((entry) => String(entry));
  const declaredRouteChecks = isPlainRecord(planView.route)
    ? asArray(planView.route.checks).map((entry) => String(entry))
    : [];
  for (const [requirement, values] of [
    ['Capability baseline', baselineChecks],
    ['Subject addition', additionChecks],
    ['Declared route', declaredRouteChecks],
  ] as const) {
    for (const checkId of values) {
      if (!sortedProfileChecks.includes(checkId)) {
        report(
          'ENVELOPE_NON_WEAKENING_VIOLATION',
          `${requirement} check "${checkId}" is not retained by the composed required-check set.`,
        );
      }
    }
  }
  const requiredEvidence = asArray(profileView.requiredChecks).flatMap((entry) => {
    const check = entry as { requiredEvidence?: unknown };
    return asArray(check.requiredEvidence).map((evidence) => String(evidence));
  });
  const expectedRequiredEvidence = sortedUnique(requiredEvidence);
  const storedRequiredEvidence = asArray(profileView.requiredAuthoritativeEvidence).map((entry) =>
    String(entry),
  );
  if (!sameStringArray(storedRequiredEvidence, expectedRequiredEvidence)) {
    report(
      'ENVELOPE_NON_WEAKENING_VIOLATION',
      `Required-authoritative evidence ${label(storedRequiredEvidence)} does not equal the composed evidence ${label(expectedRequiredEvidence)}.`,
    );
  }
  const diagnosticOnlyEvidence = asArray(profileView.diagnosticOnlyEvidence).map((entry) =>
    String(entry),
  );
  if (
    !sameStringArray(
      diagnosticOnlyEvidence,
      sortedUnique(asArray(oracle?.diagnosticOnlyEvidence).map((entry) => String(entry))),
    )
  ) {
    report(
      'ENVELOPE_NON_WEAKENING_VIOLATION',
      'Declared diagnostic-only evidence does not equal the Oracle diagnostic-only evidence.',
    );
  }
  const captureEvidence = new Set(
    asArray(profileView.capture?.evidenceItemIds).map((entry) => String(entry)),
  );
  for (const evidenceId of expectedRequiredEvidence) {
    if (!captureEvidence.has(evidenceId)) {
      report(
        'ENVELOPE_NON_WEAKENING_VIOLATION',
        `Required-authoritative evidence "${evidenceId}" is not produced by the selected capture.`,
      );
    }
    if (diagnosticOnlyEvidence.includes(evidenceId) || sortedProfileChecks.includes(evidenceId)) {
      report(
        'ENVELOPE_NON_WEAKENING_VIOLATION',
        `Diagnostic-only evidence "${evidenceId}" is not disjoint from required authority.`,
      );
    }
  }
  const toleranceIds = asArray(profileView.tolerances).map((entry) =>
    String((entry as { toleranceId?: unknown }).toleranceId),
  );
  const referencedToleranceIds = sortedUnique(
    asArray(profileView.requiredChecks).flatMap((entry) =>
      asArray((entry as { toleranceRefs?: unknown }).toleranceRefs).map((ref) => String(ref)),
    ),
  );
  if (!sameStringArray(sortedUnique(toleranceIds), referencedToleranceIds)) {
    report(
      'ENVELOPE_NON_WEAKENING_VIOLATION',
      `Resolved tolerances ${label(sortedUnique(toleranceIds))} do not equal the referenced tolerances ${label(referencedToleranceIds)}.`,
    );
  }
  const visualIds = asArray(profileView.visuals).map((entry) =>
    String((entry as { visualId?: unknown }).visualId),
  );
  const referencedVisualIds = sortedUnique(
    asArray(profileView.requiredChecks).flatMap((entry) =>
      asArray((entry as { visualRefs?: unknown }).visualRefs).map((ref) => String(ref)),
    ),
  );
  if (!sameStringArray(sortedUnique(visualIds), referencedVisualIds)) {
    report(
      'ENVELOPE_NON_WEAKENING_VIOLATION',
      `Resolved visuals ${label(sortedUnique(visualIds))} do not equal the referenced visuals ${label(referencedVisualIds)}.`,
    );
  }
  const referencedNormalizationIds = sortedUnique(
    asArray(profileView.requiredChecks)
      .map((entry) => (entry as { normalizationRef?: unknown }).normalizationRef)
      .filter((entry): entry is string => typeof entry === 'string'),
  );
  if (referencedNormalizationIds.length > 1) {
    report(
      'ENVELOPE_NON_WEAKENING_VIOLATION',
      `Required checks resolve ${referencedNormalizationIds.length} normalizations ${label(referencedNormalizationIds)}.`,
    );
  } else if (referencedNormalizationIds.length === 0) {
    if (profileView.normalization.applicable !== false) {
      report(
        'ENVELOPE_NON_WEAKENING_VIOLATION',
        'A profile whose checks reference no normalization must record the explicit non-applicable variant.',
      );
    }
  } else if (profileView.normalization.applicable !== true) {
    report(
      'ENVELOPE_NON_WEAKENING_VIOLATION',
      `A required check references normalization "${referencedNormalizationIds[0]}" but the profile records it as non-applicable.`,
    );
  } else {
    if (profileView.normalization.normalizationId !== referencedNormalizationIds[0]) {
      report(
        'ENVELOPE_NON_WEAKENING_VIOLATION',
        `Resolved normalization "${profileView.normalization.normalizationId}" does not equal the referenced normalization "${referencedNormalizationIds[0]}".`,
      );
    }
    const normalizationFingerprint = tryDerive(() =>
      deriveNormalizationFingerprint(
        normalizationDeclarationOf(
          profileView.normalization as ResolvedCorrectnessProfile['normalization'] & {
            applicable: true;
          },
        ),
      ),
    );
    if (
      !normalizationFingerprint.ok ||
      normalizationFingerprint.value !== profileView.normalization.fingerprint
    ) {
      report(
        'ENVELOPE_NON_WEAKENING_VIOLATION',
        'The resolved normalization fingerprint does not match its declaration content.',
      );
    }
  }
  const readinessCurrentness = new Set(
    asArray(profileView.readiness?.currentnessIdentities).map((entry) => String(entry)),
  );
  for (const source of asArray(profileView.capture?.requiredSources)) {
    const declaration = source as { sourceId?: unknown; required?: unknown; currentness?: unknown };
    if (declaration.required !== true) continue;
    for (const identity of asArray(declaration.currentness).map((entry) => String(entry))) {
      if (!readinessCurrentness.has(identity)) {
        report(
          'ENVELOPE_NON_WEAKENING_VIOLATION',
          `Required capture source "${String(declaration.sourceId)}" currentness "${identity}" is not declared by the readiness profile.`,
        );
      }
    }
  }

  // 16. Evaluator and compatibility discriminants against the current final
  // dispatch table and the delivered dispatch registries.
  const oracleEvaluatorKind: unknown = oracle?.evaluatorKind;
  if (!isOracleEvaluatorKind(oracleEvaluatorKind)) {
    report(
      'ENVELOPE_EVALUATOR_UNSUPPORTED',
      `Compiled Oracle evaluator "${String(oracleEvaluatorKind)}" is not a supported final evaluator discriminant.`,
    );
  } else {
    const dispatch = FINAL_EVALUATOR_DISPATCH[oracleEvaluatorKind];
    for (const entry of asArray(profileView.requiredChecks)) {
      const check = entry as { checkId?: unknown; evaluator?: unknown };
      if (!isCheckEvaluator(check.evaluator)) {
        report(
          'ENVELOPE_EVALUATOR_UNSUPPORTED',
          `Required check "${String(check.checkId)}" declares evaluator "${String(check.evaluator)}" which is not a supported check discriminant.`,
        );
        continue;
      }
      if (!dispatch.includes(check.evaluator)) {
        report(
          'ENVELOPE_EVALUATOR_UNSUPPORTED',
          `Required check "${String(check.checkId)}" evaluator "${check.evaluator}" is not dispatched by the final "${oracleEvaluatorKind}" family.`,
        );
      }
    }
  }
  const oracleRegistration = resolveOracleProfile(profileView.oracle.oracleProfileId);
  if (oracleRegistration === null) {
    report(
      'ENVELOPE_EVALUATOR_UNSUPPORTED',
      `Compiled Oracle profile "${profileView.oracle.oracleProfileId}" has no delivered dispatch registration.`,
    );
  } else {
    if (oracleRegistration.kind !== oracleEvaluatorKind) {
      report(
        'ENVELOPE_EVALUATOR_UNSUPPORTED',
        `Compiled Oracle profile "${profileView.oracle.oracleProfileId}" is registered as "${oracleRegistration.kind}" but declares evaluator "${String(oracleEvaluatorKind)}".`,
      );
    }
    if (oracleRegistration.version !== profileView.oracle.version) {
      report(
        'ENVELOPE_EVALUATOR_UNSUPPORTED',
        `Compiled Oracle profile "${profileView.oracle.oracleProfileId}" version ${String(profileView.oracle.version)} disagrees with the delivered registration version ${oracleRegistration.version}.`,
      );
    }
    if (oracleRegistration.schemaVersion !== profileView.oracle.schemaVersion) {
      report(
        'ENVELOPE_EVALUATOR_UNSUPPORTED',
        `Compiled Oracle profile "${profileView.oracle.oracleProfileId}" schema ${String(profileView.oracle.schemaVersion)} disagrees with the delivered registration schema ${oracleRegistration.schemaVersion}.`,
      );
    }
  }
  const readinessRegistration = resolveReadinessProfile(profileView.readiness.profileId);
  if (readinessRegistration === null) {
    report(
      'ENVELOPE_EVALUATOR_UNSUPPORTED',
      `Compiled readiness profile "${profileView.readiness.profileId}" has no delivered dispatch registration.`,
    );
  } else {
    const readinessComparisons: readonly [string, unknown, unknown][] = [
      [
        'deadlineCategory',
        profileView.readiness.deadlineCategory,
        readinessRegistration.profile.timingCategory,
      ],
      ['deadlineMs', profileView.readiness.deadlineMs, readinessRegistration.profile.deadlineMs],
      [
        'signalWatchdogMs',
        profileView.readiness.signalWatchdogMs,
        readinessRegistration.profile.signalWatchdogMs,
      ],
      [
        'stableFrames',
        profileView.readiness.stableFrames,
        readinessRegistration.profile.stableFrames,
      ],
      [
        'fallbackCadenceMs',
        JSON.stringify(profileView.readiness.fallbackCadenceMs),
        JSON.stringify(readinessRegistration.profile.fallbackCadenceMs),
      ],
      [
        'captureProfileId',
        profileView.capture.captureProfileId,
        readinessRegistration.captureProfileId,
      ],
      [
        'oracleProfileId',
        profileView.oracle.oracleProfileId,
        readinessRegistration.oracleProfileId,
      ],
    ];
    for (const [field, declarationValue, registrationValue] of readinessComparisons) {
      if (declarationValue !== registrationValue) {
        report(
          'ENVELOPE_EVALUATOR_UNSUPPORTED',
          `Compiled readiness "${profileView.readiness.profileId}" ${field} disagrees with the delivered registration.`,
        );
      }
    }
  }

  if (issues.length > 0) return failure(issues);
  return { ok: true };
}
