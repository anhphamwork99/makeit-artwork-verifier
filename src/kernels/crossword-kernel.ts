import { deriveResolvedCorrectnessProfileFingerprint } from '../catalogue/correctness';
import type {
  ActionCycleCorrectnessIdentity,
  CheckResultStatus,
  ConsumedCorrectnessComponentFingerprints,
  CorrectnessCheckResult,
  ResolvedCheckContract,
  ResolvedCorrectnessProfile,
} from '../contracts/correctness';
import { isFullCanonicalFingerprint } from '../contracts/correctness';
import {
  compareCrosswordExecutions,
  type CrosswordThreeChildComparison,
} from '../contracts/crossword';
import {
  CROSSWORD_EXECUTION_ROLES,
  parseCrosswordClockProfile,
  validateCrosswordExecutionChild,
  validateCrosswordExecutionSet,
  type CrosswordClockProfile,
  type CrosswordExecutionRole,
  type CrosswordObservationFinding,
  type ValidatedCrosswordExecution,
} from '../contracts/crossword-observation';
import type { Capability } from '../contracts/discriminants';
import {
  RENDER_TRANSFORM_CSS_TOLERANCE_PX,
  validateRasterRecord,
  type GeneratedVectorRasterRecordView,
} from '../contracts/raster';
import { isPlainRecord } from '../contracts/result-agreement';
import {
  CHECK_RESULT_CONTRACT_SCHEMA_VERSION,
  RESOLVED_CORRECTNESS_PROFILE_SCHEMA_VERSION,
} from '../contracts/schema-versions';

/**
 * P7-B B1-E inactive final compiled-profile kernel for Crossword
 * generation/determinism (ADR 0028 §3 B1-E).
 *
 * A generated-Crossword creation is proven by the accepted `crossword-determinism`
 * Oracle (WP5 Slice 5-E; ADR 0017 R4–R8; ADR 0018 CR9). That Oracle consumes one
 * accepted three-child execution set (A1, A2, B) under the governed fixed-wall
 * clock profile and resolves the declared checks (`crossword.created`,
 * `crossword.seed-derived`, `crossword.semantic-valid`,
 * `crossword.same-seed-repeatable`, `crossword.different-seed-sensitive`, and
 * `crossword.raster-current`). A1 and A2 share one release epoch and must be
 * byte-identical; B uses a distinct epoch and must be sensitive.
 *
 * This kernel is the *inactive final* consumer of those facts. It receives
 * exactly the compiled `ResolvedCorrectnessProfile`, the route the runtime
 * resolved, the Action Cycle correctness identity that observed the action, and
 * the accepted Crossword facts:
 *
 *  1. the governed fixed-wall clock profile the drive installed (parsed by the
 *     accepted observation contract, never trusted as an opaque shape);
 *  2. the accepted source-contract fingerprint the materialization binds;
 *  3. the delivered three-child execution observations (seed + generated layout
 *     + semantic digest + currentness + raster authority), re-validated here by
 *     the accepted observation contract so missing/stale/torn/malformed/
 *     wrong-target authority is unusable even when a boolean fact claims
 *     otherwise;
 *  4. the delivered structured per-check evaluator facts (authority,
 *     currentness, source agreement, and product mismatch) plus the raw named
 *     primitive Crossword Oracle predicates the inactive B2-B4 adapter projected
 *     from the delivered Oracle observations, and the accepted comparison
 *     projection; and
 *  5. the observed evidence roles for the Action Cycle.
 *
 * It returns one complete, field-rich `CorrectnessCheckResult` per declared
 * required check — or, when the compiled profile itself is not trustworthy, no
 * fabricated checks at all.
 *
 * The legacy aggregate `harnessInvalid` flag and the legacy per-check boolean
 * `passed` are deliberately absent from the fact contract: authority,
 * currentness, source agreement, and product mismatch are carried as separate
 * structured facts so no boolean check result is translated into a final status.
 *
 * Every correctness input is read from the compiled profile. This module owns no
 * required-check list, no check id, no tolerance/visual/normalization literal,
 * no deadline/seed/word policy, no fallback id, and no Subject-name/family/
 * scenario branch; it never reloads an authoring catalogue. The accepted
 * Crossword meaning is preserved exactly, including the B0 warning-authority
 * distinction:
 *
 *  - a trustworthy product mismatch (seed epoch, word/layout, repeat stability,
 *    seed sensitivity/collision, raster region non-convergence) after valid,
 *    current, interpretable authority is `FAIL`;
 *  - missing / stale / torn / malformed / wrong-target / uninterpretable
 *    execution, raster, clock, or source authority is `UNUSABLE`;
 *  - a diagnostic-only item can never rescue a required check.
 *
 * The kernel is deliberately inactive. Nothing here is imported by the active
 * executor, Oracle, classifier, writer, or CLI, and no module under `src/runtime`
 * or `src/oracles` is imported in return: the fact contracts below are
 * structurally satisfied by the accepted `CrosswordOracleEvaluation` projection
 * and the accepted execution child/clock shapes, so the atomic B2 cutover can
 * pass the delivered facts in without this module depending on active machinery.
 */

/** The single delivered Crossword evaluator family this kernel owns. */
export const CROSSWORD_KERNEL_KINDS = ['crossword-determinism'] as const;
export type CrosswordKernelKind = (typeof CROSSWORD_KERNEL_KINDS)[number];

/** The compiled Oracle discriminant the Crossword route resolves. */
export const CROSSWORD_KERNEL_EVALUATOR = 'crossword-determinism';

/**
 * The closed per-check evaluator discriminants the `crossword-determinism`
 * Oracle declares. A compiled profile that declares a different check evaluator
 * cannot be interpreted by this kernel.
 */
export const CROSSWORD_KERNEL_CHECK_EVALUATORS = ['crossword-determinism'] as const;

/**
 * Closed evidence-availability vocabulary. Only `authoritative` evidence is
 * current and interpretable; every other state makes a required check
 * `UNUSABLE`. `diagnostic-only` is the single role that must never satisfy a
 * required check.
 */
export const CROSSWORD_EVIDENCE_AVAILABILITY = [
  'authoritative',
  'ambiguous',
  'diagnostic-only',
  'malformed',
  'missing',
  'stale',
  'torn',
] as const;
export type CrosswordEvidenceAvailability = (typeof CROSSWORD_EVIDENCE_AVAILABILITY)[number];

export function isCrosswordEvidenceAvailability(
  value: unknown,
): value is CrosswordEvidenceAvailability {
  return (
    typeof value === 'string' &&
    (CROSSWORD_EVIDENCE_AVAILABILITY as readonly string[]).includes(value)
  );
}

/** One accepted evidence fact the runtime actually observed for a check. */
export interface CrosswordEvidenceFact {
  readonly evidenceId: string;
  readonly availability: CrosswordEvidenceAvailability;
}

/** Closed authority state recorded in every `actual` interpretation. */
export const CROSSWORD_AUTHORITY_STATES = [
  'ambiguous',
  'current',
  'malformed',
  'missing',
  'stale',
  'torn',
  'unavailable',
  'wrong-target',
] as const;
export type CrosswordAuthorityState = (typeof CROSSWORD_AUTHORITY_STATES)[number];

/**
 * Closed structured currentness vocabulary for one accepted evaluator fact
 * (ADR 0029 §4 B2-B). Currentness is an explicit structured fact recorded per
 * check; it is never a final result status.
 */
export const CROSSWORD_FACT_CURRENTNESS = ['current', 'stale', 'torn', 'unavailable'] as const;
export type CrosswordFactCurrentness = (typeof CROSSWORD_FACT_CURRENTNESS)[number];

/** Projects a structured authority state onto the closed currentness domain. */
export function crosswordCurrentnessForAuthority(
  authority: CrosswordAuthorityState,
): CrosswordFactCurrentness {
  if (authority === 'current') return 'current';
  if (authority === 'stale') return 'stale';
  if (authority === 'torn') return 'torn';
  return 'unavailable';
}

function isCrosswordAuthorityState(value: unknown): value is CrosswordAuthorityState {
  return (
    typeof value === 'string' && (CROSSWORD_AUTHORITY_STATES as readonly string[]).includes(value)
  );
}

function isCrosswordFactCurrentness(value: unknown): value is CrosswordFactCurrentness {
  return (
    typeof value === 'string' && (CROSSWORD_FACT_CURRENTNESS as readonly string[]).includes(value)
  );
}

/**
 * One accepted per-check Crossword evaluator fact in explicit structured form
 * (ADR 0029 §4 B2-B). The legacy boolean `passed` is replaced by structured
 * authority, currentness, source-agreement, and product-mismatch facts so the
 * kernel maps them to a status from explicit structure instead of translating a
 * boolean check result. The facts are supplied by the inactive B2-B4 live-fact
 * adapter from the delivered Oracle observations; this module owns no predicate
 * policy of its own.
 */
export interface CrosswordEvaluatorFact {
  readonly checkId: string;
  /** Structured authority state of the accepted evaluator fact. */
  readonly authority: CrosswordAuthorityState;
  /** Structured currentness of the accepted evaluator fact. */
  readonly currentness: CrosswordFactCurrentness;
  /** Whether the independent governed-clock/source/execution sources agreed. */
  readonly sourcesAgree: boolean;
  /** A trustworthy product mismatch under a current authority. */
  readonly mismatch: boolean;
}

/** One raw primitive per-check predicate of the accepted Crossword Oracle. */
export interface CrosswordPrimitiveCheckFactView {
  readonly checkId: string;
  readonly predicateMet: boolean;
}

/** Raw accepted three-child comparison primitives. */
export interface CrosswordPrimitiveComparisonFactView {
  readonly sameSeedPair: boolean;
  readonly differentSeedPair: boolean;
  readonly repeatIdentical: boolean;
  readonly seedSensitivity: boolean;
  readonly collision: boolean;
  readonly wordsEqualAcrossChildren: boolean;
  readonly distinctDocuments: boolean;
}

/**
 * The additive named primitive Crossword Oracle facts the inactive B2-B4 adapter
 * consumed. Every field is a raw primitive observation (a structured authority,
 * the independent governed-clock/source-agreement primitive, the raw accepted
 * child comparison/repeat/sensitivity/collision, governed clock, currentness,
 * and raster primitives, and one predicate per selected check); no field is a
 * legacy composite boolean check result.
 */
export interface CrosswordOracleFactsView {
  readonly authority: 'current' | 'malformed';
  readonly sourceAgreement: boolean;
  readonly comparison: CrosswordPrimitiveComparisonFactView | null;
  readonly clockEpochs: readonly number[] | null;
  readonly currentnessDistinct: boolean;
  readonly rasterCurrent: boolean;
  readonly checks: readonly CrosswordPrimitiveCheckFactView[];
}

/** The route a kernel is asked to evaluate. Passed in; never selected internally. */
export interface CrosswordKernelRoute {
  readonly subjectId: string;
  readonly capability: Capability;
  readonly variant: string | null;
}

/** Defensive projection of one raw accepted execution child, for `actual`. */
export interface CrosswordKernelChildProjection {
  readonly executionRole: CrosswordExecutionRole;
  readonly present: boolean;
  readonly actualSeed: number | null;
  readonly generationSeed: number | null;
  readonly expectedSeed: number | null;
  readonly sourceContractFingerprint: string | null;
  readonly words: readonly string[];
  readonly omittedWords: readonly string[];
  readonly wordsFingerprint: string | null;
  readonly semanticLayoutDigest: string | null;
  readonly observationId: string | null;
  readonly createdTargetId: string | null;
  readonly targetGeometry: {
    readonly id: string | null;
    readonly x: number | null;
    readonly y: number | null;
    readonly width: number | null;
    readonly height: number | null;
  } | null;
  readonly raster: {
    readonly schemaVersion: number | null;
    readonly authorityKind: string | null;
    readonly id: string | null;
    readonly kind: string | null;
    readonly status: string | null;
    readonly mounted: boolean;
    readonly rasterFingerprint: string | null;
    readonly rendererTargetFingerprint: string | null;
    readonly region: {
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
    } | null;
  } | null;
}

/**
 * Accepted Crossword evaluator facts plus the accepted clock/source/execution
 * observations and the observed evidence roles.
 *
 * The legacy aggregate `harnessInvalid` flag and the legacy per-check
 * `passed` boolean are deliberately absent: `checks` carries the explicit
 * structured authority/currentness/source-agreement/mismatch facts for every
 * declared check, and `oracleFacts` carries the accepted Oracle's raw named
 * primitive predicate projection. The raw accepted `comparison` remains as a
 * delivered observation for the `actual` payload. The execution set and clock
 * are typed `unknown` so the kernel validates them through the accepted
 * observation contract rather than trusting a caller-supplied shape.
 */
export interface CrosswordKernelFacts {
  readonly evaluator: typeof CROSSWORD_KERNEL_EVALUATOR;
  readonly clock: unknown;
  readonly sourceFingerprintExpected: string;
  readonly executions: readonly unknown[];
  readonly checks: readonly CrosswordEvaluatorFact[];
  readonly comparison: CrosswordThreeChildComparison | null;
  readonly oracleFacts: CrosswordOracleFactsView | null;
  readonly diagnostics: readonly { readonly code: string; readonly detail: string }[];
  readonly evidence: readonly CrosswordEvidenceFact[];
}

/** Closed kernel issue vocabulary; deliberately local to the inactive kernel. */
export const CROSSWORD_KERNEL_ISSUE_CODES = [
  'CROSSWORD_KERNEL_PROFILE_NOT_OBJECT',
  'CROSSWORD_KERNEL_PROFILE_SCHEMA_UNSUPPORTED',
  'CROSSWORD_KERNEL_PROFILE_FINGERPRINT_MISSING',
  'CROSSWORD_KERNEL_PROFILE_FINGERPRINT_INVALID',
  'CROSSWORD_KERNEL_PROFILE_FINGERPRINT_MISMATCH',
  'CROSSWORD_KERNEL_COMPONENT_FINGERPRINT_INVALID',
  'CROSSWORD_KERNEL_ROUTE_MISMATCH',
  'CROSSWORD_KERNEL_ORACLE_EVALUATOR_UNSUPPORTED',
  'CROSSWORD_KERNEL_CHECK_EVALUATOR_UNSUPPORTED',
  'CROSSWORD_KERNEL_REQUIRED_CHECK_MISSING',
  'CROSSWORD_KERNEL_REQUIRED_CHECK_DUPLICATE',
  'CROSSWORD_KERNEL_EMPTY_REQUIRED_CHECKS',
  'CROSSWORD_KERNEL_ACTION_CYCLE_MISMATCH',
  'CROSSWORD_KERNEL_READINESS_MISMATCH',
  'CROSSWORD_KERNEL_FACTS_EVALUATOR_MISMATCH',
  'CROSSWORD_KERNEL_FACT_CHECK_MISSING',
  'CROSSWORD_KERNEL_FACT_CHECK_UNKNOWN',
  'CROSSWORD_KERNEL_FACT_CHECK_DUPLICATE',
  'CROSSWORD_KERNEL_FACT_STATUS_UNKNOWN',
  'CROSSWORD_KERNEL_FACT_AUTHORITY_UNKNOWN',
  'CROSSWORD_KERNEL_EXECUTION_AUTHORITY_UNUSABLE',
  'CROSSWORD_KERNEL_SOURCE_DRIFT',
  'CROSSWORD_KERNEL_EVIDENCE_UNDECLARED',
  'CROSSWORD_KERNEL_EVIDENCE_DIAGNOSTIC_ONLY',
] as const;
export type CrosswordKernelIssueCode = (typeof CROSSWORD_KERNEL_ISSUE_CODES)[number];

export interface CrosswordKernelIssue {
  readonly code: CrosswordKernelIssueCode;
  readonly detail: string;
  readonly checkId: string | null;
}

export interface CrosswordKernelResult {
  readonly kind: CrosswordKernelKind;
  /**
   * `true` when the compiled profile was trustworthy and a complete check
   * result was produced for every declared check (possibly all `UNUSABLE`).
   * `false` when the profile itself failed validation; `checks` is then empty
   * because no trustworthy check may be fabricated from an invalid profile.
   */
  readonly ok: boolean;
  readonly checks: readonly CorrectnessCheckResult[];
  readonly issues: readonly CrosswordKernelIssue[];
}

export interface CrosswordKernelInput {
  readonly profile: ResolvedCorrectnessProfile;
  readonly route: CrosswordKernelRoute;
  readonly actionCycle: ActionCycleCorrectnessIdentity;
  readonly facts: CrosswordKernelFacts;
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

function issue(
  code: CrosswordKernelIssueCode,
  detail: string,
  checkId: string | null = null,
): CrosswordKernelIssue {
  return { code, detail, checkId };
}

function sortStrings(values: readonly string[]): string[] {
  return [...values].sort();
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function stringArrayOrEmpty(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

function consumedFingerprints(
  profile: ResolvedCorrectnessProfile,
): ConsumedCorrectnessComponentFingerprints {
  return {
    resolvedProfile: profile.resolvedFingerprint,
    requiredCheckSet: profile.componentFingerprints.requiredCheckSet,
    oracle: profile.componentFingerprints.oracle,
    capture: profile.componentFingerprints.capture,
    tolerances: profile.componentFingerprints.tolerances,
    visuals: profile.componentFingerprints.visuals,
    normalization: profile.componentFingerprints.normalization,
  };
}

/**
 * Validates that the compiled profile is exactly the immutable Crossword
 * profile for the requested route and that the Action Cycle observed the same
 * profile. Every failure is fail-closed and reported as a structured issue; the
 * fingerprint is independently recomputed from the profile content so a mutated
 * compiled field is detected rather than trusted.
 */
function validateProfile(
  profile: ResolvedCorrectnessProfile,
  route: CrosswordKernelRoute,
  actionCycle: ActionCycleCorrectnessIdentity,
): CrosswordKernelIssue[] {
  const issues: CrosswordKernelIssue[] = [];
  if (!isPlainRecord(profile)) {
    issues.push(
      issue('CROSSWORD_KERNEL_PROFILE_NOT_OBJECT', 'The compiled profile is not a plain object.'),
    );
    return issues;
  }
  if (profile.schemaVersion !== RESOLVED_CORRECTNESS_PROFILE_SCHEMA_VERSION) {
    issues.push(
      issue(
        'CROSSWORD_KERNEL_PROFILE_SCHEMA_UNSUPPORTED',
        `Resolved-profile schema ${String(profile.schemaVersion)} is not supported.`,
      ),
    );
  }

  const storedFingerprint = profile.resolvedFingerprint;
  if (storedFingerprint === undefined || storedFingerprint === null) {
    issues.push(
      issue(
        'CROSSWORD_KERNEL_PROFILE_FINGERPRINT_MISSING',
        'The compiled profile carries no resolved fingerprint.',
      ),
    );
  } else if (!isFullCanonicalFingerprint(storedFingerprint)) {
    issues.push(
      issue(
        'CROSSWORD_KERNEL_PROFILE_FINGERPRINT_INVALID',
        'The compiled resolved fingerprint is not a full canonical 64-hex identity.',
      ),
    );
  } else {
    const preimage = Object.fromEntries(
      Object.entries(profile).filter(([key]) => key !== 'resolvedFingerprint'),
    ) as unknown as Omit<ResolvedCorrectnessProfile, 'resolvedFingerprint'>;
    if (deriveResolvedCorrectnessProfileFingerprint(preimage) !== storedFingerprint) {
      issues.push(
        issue(
          'CROSSWORD_KERNEL_PROFILE_FINGERPRINT_MISMATCH',
          'The compiled resolved fingerprint does not match the profile content; a compiled field was mutated.',
        ),
      );
    }
  }

  const componentFingerprints = profile.componentFingerprints;
  if (!isPlainRecord(componentFingerprints)) {
    issues.push(
      issue(
        'CROSSWORD_KERNEL_COMPONENT_FINGERPRINT_INVALID',
        'The compiled profile carries no component fingerprints.',
      ),
    );
  } else {
    for (const field of COMPONENT_FINGERPRINT_FIELDS) {
      if (!isFullCanonicalFingerprint(componentFingerprints[field])) {
        issues.push(
          issue(
            'CROSSWORD_KERNEL_COMPONENT_FINGERPRINT_INVALID',
            `Compiled component fingerprint "${field}" is not a full canonical 64-hex identity.`,
          ),
        );
      }
    }
  }

  if (
    profile.subjectId !== route.subjectId ||
    profile.capability !== route.capability ||
    profile.variant !== route.variant
  ) {
    issues.push(
      issue(
        'CROSSWORD_KERNEL_ROUTE_MISMATCH',
        `Compiled profile route ${profile.subjectId}×${String(profile.capability)}@${profile.variant ?? '∅'} does not equal the requested route ${route.subjectId}×${String(route.capability)}@${route.variant ?? '∅'}.`,
      ),
    );
  }

  const oracle: unknown = profile.oracle;
  if (!isPlainRecord(oracle) || oracle.evaluatorKind !== CROSSWORD_KERNEL_EVALUATOR) {
    const found = isPlainRecord(oracle) ? String(oracle.evaluatorKind) : 'undefined';
    issues.push(
      issue(
        'CROSSWORD_KERNEL_ORACLE_EVALUATOR_UNSUPPORTED',
        `Compiled Oracle evaluator "${found}" is not supported by this Crossword kernel (expected "${CROSSWORD_KERNEL_EVALUATOR}").`,
      ),
    );
  }

  const requiredChecks = Array.isArray(profile.requiredChecks) ? profile.requiredChecks : [];
  if (requiredChecks.length === 0) {
    issues.push(
      issue(
        'CROSSWORD_KERNEL_EMPTY_REQUIRED_CHECKS',
        'A compiled profile with no declared required check cannot produce a check result.',
      ),
    );
  }
  const seen = new Set<string>();
  for (const check of requiredChecks) {
    const checkId = typeof check.checkId === 'string' ? check.checkId : null;
    if (checkId === null) {
      issues.push(
        issue(
          'CROSSWORD_KERNEL_REQUIRED_CHECK_MISSING',
          'A declared required check has no check id.',
        ),
      );
      continue;
    }
    if (seen.has(checkId)) {
      issues.push(
        issue(
          'CROSSWORD_KERNEL_REQUIRED_CHECK_DUPLICATE',
          `Declared required check "${checkId}" appears more than once.`,
          checkId,
        ),
      );
      continue;
    }
    seen.add(checkId);
    if (
      typeof check.evaluator !== 'string' ||
      !(CROSSWORD_KERNEL_CHECK_EVALUATORS as readonly string[]).includes(check.evaluator)
    ) {
      issues.push(
        issue(
          'CROSSWORD_KERNEL_CHECK_EVALUATOR_UNSUPPORTED',
          `Required check "${checkId}" declares evaluator "${String(check.evaluator)}" which this Crossword kernel does not support.`,
          checkId,
        ),
      );
    }
  }

  if (actionCycle.resolvedProfileFingerprint !== storedFingerprint) {
    issues.push(
      issue(
        'CROSSWORD_KERNEL_ACTION_CYCLE_MISMATCH',
        'The Action Cycle resolved-profile fingerprint does not equal the compiled profile fingerprint.',
      ),
    );
  }
  if (actionCycle.readinessFingerprint !== profile.componentFingerprints?.readiness) {
    issues.push(
      issue(
        'CROSSWORD_KERNEL_READINESS_MISMATCH',
        'The Action Cycle readiness fingerprint does not equal the compiled readiness component.',
      ),
    );
  }
  return issues;
}

interface EvidenceConsumption {
  readonly consumed: readonly string[];
  readonly authoritative: boolean;
  readonly authorityState: CrosswordAuthorityState;
}

/**
 * Derives the exact required-authoritative evidence a check actually consumed.
 * Only declared required evidence in the `authoritative` state is consumed.
 * Diagnostic-only, undeclared, missing, stale, torn, ambiguous, or malformed
 * evidence is never consumed, and any non-authoritative required evidence makes
 * the check `UNUSABLE` rather than silently passing.
 */
function consumeRequiredEvidence(
  contract: ResolvedCheckContract,
  profile: ResolvedCorrectnessProfile,
  facts: readonly CrosswordEvidenceFact[],
  issues: CrosswordKernelIssue[],
): EvidenceConsumption {
  const checkId = contract.checkId;
  const byId = new Map<string, CrosswordEvidenceFact>();
  for (const fact of facts) {
    if (isPlainRecord(fact) && typeof fact.evidenceId === 'string') {
      byId.set(fact.evidenceId, fact as unknown as CrosswordEvidenceFact);
    }
  }
  const globalDeclared = new Set(profile.requiredAuthoritativeEvidence);
  const consumed: string[] = [];
  let authorityState: CrosswordAuthorityState = 'current';

  for (const requiredId of sortStrings(contract.requiredEvidence)) {
    if (!globalDeclared.has(requiredId)) {
      issues.push(
        issue(
          'CROSSWORD_KERNEL_EVIDENCE_UNDECLARED',
          `Check "${checkId}" declares required evidence "${requiredId}" that the compiled profile does not declare required-authoritative.`,
          checkId,
        ),
      );
      authorityState = 'unavailable';
      continue;
    }
    const fact = byId.get(requiredId);
    if (fact === undefined || fact.availability === 'missing') {
      authorityState = authorityState === 'current' ? 'missing' : authorityState;
      continue;
    }
    if (fact.availability === 'diagnostic-only') {
      issues.push(
        issue(
          'CROSSWORD_KERNEL_EVIDENCE_DIAGNOSTIC_ONLY',
          `Check "${checkId}" required-authoritative evidence "${requiredId}" was observed as diagnostic-only; a diagnostic item cannot satisfy a required check.`,
          checkId,
        ),
      );
      authorityState = 'unavailable';
      continue;
    }
    if (fact.availability !== 'authoritative') {
      authorityState = fact.availability;
      continue;
    }
    consumed.push(requiredId);
  }

  // Undeclared evidence claiming authority is reported even though it is never
  // consumed, so an executor cannot smuggle uncalibrated evidence into a result.
  for (const fact of facts) {
    if (!isPlainRecord(fact) || typeof fact.evidenceId !== 'string') continue;
    if (fact.availability === 'authoritative' && !globalDeclared.has(fact.evidenceId)) {
      issues.push(
        issue(
          'CROSSWORD_KERNEL_EVIDENCE_UNDECLARED',
          `Evidence "${fact.evidenceId}" claims authority but is not declared required-authoritative by the compiled profile.`,
          checkId,
        ),
      );
    }
  }

  const required = sortStrings(contract.requiredEvidence);
  const authoritative = required.every((evidenceId) => consumed.includes(evidenceId));
  return {
    consumed,
    authoritative,
    authorityState: authoritative ? 'current' : authorityState,
  };
}

interface ExecutionAuthority {
  readonly state: CrosswordAuthorityState;
  readonly detail: string;
  readonly executions: readonly ValidatedCrosswordExecution[];
  readonly clock: CrosswordClockProfile | null;
}

/**
 * Classifies one raw execution observation against the accepted raster/target
 * contract. A status `torn` record, an unstable acquisition capture, or a
 * failed structural validation is a precise unusable authority state; only a
 * ready generated-vector record targeting the exact created target is current.
 */
function classifyRasterAuthority(rawChild: Record<string, unknown>): {
  state: CrosswordAuthorityState;
  detail: string;
} {
  const raster = rawChild.raster;
  if (raster === null || raster === undefined) {
    return { state: 'missing', detail: 'The child carries no raster record.' };
  }
  const status = isPlainRecord(raster) ? raster.status : undefined;
  if (status === 'torn') {
    return { state: 'torn', detail: 'The child raster record is torn.' };
  }
  if (status === 'failed') {
    return { state: 'unavailable', detail: 'The child raster record failed.' };
  }
  if (status === 'pending' || status === 'not-applicable') {
    return {
      state: 'stale',
      detail: `The child raster record reports ${String(status)}; authority is not current.`,
    };
  }
  const validation = validateRasterRecord(raster);
  if (!validation.ok) {
    const code = validation.diagnostic?.code;
    const state: CrosswordAuthorityState =
      code === 'RASTER_OBSERVATION_TORN'
        ? 'torn'
        : code === 'RASTER_TARGET_ID_MISMATCH'
          ? 'wrong-target'
          : code === 'RASTER_NODE_AMBIGUOUS'
            ? 'ambiguous'
            : code === 'RASTER_SOURCE_UNREADABLE'
              ? 'missing'
              : code === 'RASTER_SCHEMA_UNSUPPORTED'
                ? 'malformed'
                : 'unavailable';
    return { state, detail: validation.detail };
  }
  // Structurally valid but the child cross-check still failed: the exact target,
  // mount, and renderer fingerprints must agree with the accepted currentness.
  const currentness = isPlainRecord(rawChild.currentness) ? rawChild.currentness : null;
  const createdTargetId =
    currentness !== null && typeof currentness.createdTargetId === 'string'
      ? currentness.createdTargetId
      : null;
  const record = raster as unknown as GeneratedVectorRasterRecordView;
  if (record.id !== createdTargetId) {
    return {
      state: 'wrong-target',
      detail: `Raster target id "${String(record.id)}" does not equal the created target "${String(createdTargetId)}".`,
    };
  }
  if (record.mounted !== true) {
    return { state: 'stale', detail: 'The child raster record is not mounted.' };
  }
  if (currentness !== null && record.rasterFingerprint !== currentness.rasterFingerprint) {
    return {
      state: 'stale',
      detail:
        'The child raster fingerprint does not equal the accepted currentness raster fingerprint.',
    };
  }
  if (
    currentness !== null &&
    record.renderer?.targetFingerprint !== currentness.rendererFingerprint
  ) {
    return {
      state: 'stale',
      detail:
        'The child renderer fingerprint does not equal the accepted currentness renderer fingerprint.',
    };
  }
  return { state: 'unavailable', detail: 'The child raster authority is not interpretable.' };
}

function classifyFinding(
  rawChild: Record<string, unknown>,
  finding: CrosswordObservationFinding,
): { state: CrosswordAuthorityState; detail: string } {
  switch (finding.code) {
    case 'CROSSWORD_RASTER_AUTHORITY_UNUSABLE':
      return classifyRasterAuthority(rawChild);
    case 'CROSSWORD_OBSERVATION_MISSING':
      return { state: 'missing', detail: finding.detail };
    case 'CROSSWORD_OBSERVATION_DUPLICATE':
      return { state: 'ambiguous', detail: finding.detail };
    default:
      return { state: 'malformed', detail: finding.detail };
  }
}

function classifyChildAuthority(
  raw: unknown,
  sourceFingerprintExpected: string,
): { state: CrosswordAuthorityState; detail: string } {
  if (!isPlainRecord(raw)) {
    return { state: 'malformed', detail: 'An execution child observation is not an object.' };
  }
  const validation = validateCrosswordExecutionChild(raw);
  if (validation.ok) {
    if (validation.child.sourceContractFingerprint !== sourceFingerprintExpected) {
      return {
        state: 'stale',
        detail: `Child "${validation.child.executionRole}" carries a source-contract fingerprint other than the accepted one; the materialization no longer binds the accepted product revision.`,
      };
    }
    return { state: 'current', detail: 'Child authority is current.' };
  }
  return classifyFinding(raw, validation.finding);
}

/**
 * Recomputes the accepted three-child execution authority from the delivered
 * clock profile and raw child observations through the accepted observation
 * contract. A malformed clock, a missing/duplicated/malformed child, an
 * unusable raster, or a drifted source fingerprint is a precise unusable
 * authority state; only a complete, mutually consistent, current set is
 * `current`. No boolean fact may rescue a non-current authority.
 */
function readExecutionAuthority(facts: CrosswordKernelFacts): ExecutionAuthority {
  const rawExecutions = Array.isArray(facts.executions) ? facts.executions : [];

  for (const raw of rawExecutions) {
    const classification = classifyChildAuthority(raw, facts.sourceFingerprintExpected);
    if (classification.state !== 'current') {
      return { ...classification, executions: [], clock: null };
    }
  }

  const clockValidation = parseCrosswordClockProfile(facts.clock);
  if (!clockValidation.ok) {
    return {
      state: 'malformed',
      detail: clockValidation.finding.detail,
      executions: [],
      clock: null,
    };
  }

  const setValidation = validateCrosswordExecutionSet({
    clock: facts.clock,
    sourceFingerprintExpected: facts.sourceFingerprintExpected,
    executions: facts.executions,
  });
  if (!setValidation.ok) {
    const finding = setValidation.findings[0];
    const state: CrosswordAuthorityState =
      finding.code === 'CROSSWORD_OBSERVATION_MISSING'
        ? 'missing'
        : finding.code === 'CROSSWORD_OBSERVATION_DUPLICATE'
          ? 'ambiguous'
          : 'malformed';
    return { state, detail: finding.detail, executions: [], clock: clockValidation.clock };
  }

  return {
    state: 'current',
    detail: 'The accepted three-child Crossword execution authority is current.',
    executions: setValidation.set.executions,
    clock: setValidation.set.clock,
  };
}

/**
 * A structured evaluator fact is well formed only when authority/currentness
 * are closed values and the source-agreement/mismatch facts are explicit
 * booleans. An incomplete or legacy-shaped record is never interpreted as a
 * final status.
 */
function isWellFormedEvaluatorFact(value: unknown): value is CrosswordEvaluatorFact {
  return (
    isPlainRecord(value) &&
    typeof value.checkId === 'string' &&
    isCrosswordAuthorityState(value.authority) &&
    isCrosswordFactCurrentness(value.currentness) &&
    typeof value.sourcesAgree === 'boolean' &&
    typeof value.mismatch === 'boolean'
  );
}

/**
 * Validates the accepted Crossword check facts against the compiled
 * required-check set: a declared check may have exactly one explicit structured
 * fact, and an undeclared or legacy-shaped check fact is rejected without being
 * consumed.
 */
function validateCheckFacts(
  profile: ResolvedCorrectnessProfile,
  facts: CrosswordKernelFacts,
  issues: CrosswordKernelIssue[],
): void {
  const declaredIds = new Set(profile.requiredChecks.map((entry) => entry.checkId));
  const seenFactIds = new Set<string>();
  for (const fact of Array.isArray(facts.checks) ? facts.checks : []) {
    if (!isPlainRecord(fact) || typeof fact.checkId !== 'string') {
      issues.push(
        issue('CROSSWORD_KERNEL_FACT_STATUS_UNKNOWN', 'A Crossword check fact has no check id.'),
      );
      continue;
    }
    if (seenFactIds.has(fact.checkId)) {
      issues.push(
        issue(
          'CROSSWORD_KERNEL_FACT_CHECK_DUPLICATE',
          `Crossword check fact "${fact.checkId}" appears more than once.`,
          fact.checkId,
        ),
      );
      continue;
    }
    seenFactIds.add(fact.checkId);
    if (!declaredIds.has(fact.checkId)) {
      issues.push(
        issue(
          'CROSSWORD_KERNEL_FACT_CHECK_UNKNOWN',
          `Crossword check fact "${fact.checkId}" is not a declared required check.`,
          fact.checkId,
        ),
      );
    }
    if (!isWellFormedEvaluatorFact(fact)) {
      issues.push(
        issue(
          'CROSSWORD_KERNEL_FACT_AUTHORITY_UNKNOWN',
          `Crossword check fact "${fact.checkId}" carries no explicit structured authority/currentness/source-agreement/mismatch facts.`,
          fact.checkId,
        ),
      );
    }
  }
}

/** Defensive projection of the delivered raw children for the `actual` payload. */
function projectChildren(
  executions: readonly unknown[],
): readonly CrosswordKernelChildProjection[] {
  const byRole = new Map<CrosswordExecutionRole, Record<string, unknown>>();
  for (const raw of executions) {
    if (
      isPlainRecord(raw) &&
      typeof raw.executionRole === 'string' &&
      (CROSSWORD_EXECUTION_ROLES as readonly string[]).includes(raw.executionRole)
    ) {
      byRole.set(raw.executionRole as CrosswordExecutionRole, raw);
    }
  }
  return CROSSWORD_EXECUTION_ROLES.map((executionRole) => {
    const raw = byRole.get(executionRole);
    if (raw === undefined) {
      return {
        executionRole,
        present: false,
        actualSeed: null,
        generationSeed: null,
        expectedSeed: null,
        sourceContractFingerprint: null,
        words: [],
        omittedWords: [],
        wordsFingerprint: null,
        semanticLayoutDigest: null,
        observationId: null,
        createdTargetId: null,
        targetGeometry: null,
        raster: null,
      };
    }
    const currentness = isPlainRecord(raw.currentness) ? raw.currentness : null;
    const clock = isPlainRecord(raw.clock) ? raw.clock : null;
    const geometry = isPlainRecord(raw.targetGeometry) ? raw.targetGeometry : null;
    const raster = isPlainRecord(raw.raster) ? raw.raster : null;
    const region = raster !== null && isPlainRecord(raster.region) ? raster.region : null;
    const renderer = raster !== null && isPlainRecord(raster.renderer) ? raster.renderer : null;
    const layout = isPlainRecord(raw.layout) ? raw.layout : null;
    return {
      executionRole,
      present: true,
      actualSeed: numberOrNull(raw.actualSeed),
      generationSeed: currentness === null ? null : numberOrNull(currentness.generationSeed),
      expectedSeed: clock === null ? null : numberOrNull(clock.expectedSeed),
      sourceContractFingerprint: stringOrNull(raw.sourceContractFingerprint),
      words: stringArrayOrEmpty(raw.words),
      omittedWords: layout === null ? [] : stringArrayOrEmpty(layout.omittedWords),
      wordsFingerprint: currentness === null ? null : stringOrNull(currentness.wordsFingerprint),
      semanticLayoutDigest:
        currentness === null ? null : stringOrNull(currentness.semanticLayoutDigest),
      observationId: stringOrNull(raw.observationId),
      createdTargetId: currentness === null ? null : stringOrNull(currentness.createdTargetId),
      targetGeometry:
        geometry === null
          ? null
          : {
              id: stringOrNull(geometry.id),
              x: numberOrNull(geometry.x),
              y: numberOrNull(geometry.y),
              width: numberOrNull(geometry.width),
              height: numberOrNull(geometry.height),
            },
      raster:
        raster === null
          ? null
          : {
              schemaVersion: numberOrNull(raster.rasterSchemaVersion),
              authorityKind: stringOrNull(raster.authorityKind),
              id: stringOrNull(raster.id),
              kind: stringOrNull(raster.kind),
              status: stringOrNull(raster.status),
              mounted: raster.mounted === true,
              rasterFingerprint: stringOrNull(raster.rasterFingerprint),
              rendererTargetFingerprint:
                renderer === null ? null : stringOrNull(renderer.targetFingerprint),
              region:
                region === null
                  ? null
                  : {
                      x: numberOrNull(region.x) ?? 0,
                      y: numberOrNull(region.y) ?? 0,
                      width: numberOrNull(region.width) ?? 0,
                      height: numberOrNull(region.height) ?? 0,
                    },
            },
    };
  });
}

function expectedPayload(
  profile: ResolvedCorrectnessProfile,
  contract: ResolvedCheckContract,
  facts: CrosswordKernelFacts,
  clock: CrosswordClockProfile | null,
): Record<string, unknown> {
  return {
    schema: contract.expectedSchema,
    evaluator: contract.evaluator,
    oracleProfileId: profile.oracle.oracleProfileId,
    checkId: contract.checkId,
    executionRoles: [...CROSSWORD_EXECUTION_ROLES],
    sourceFingerprintExpected: stringOrNull(facts.sourceFingerprintExpected),
    clock:
      clock === null
        ? null
        : {
            schemaVersion: clock.schemaVersion,
            profileId: clock.profileId,
            providerId: clock.providerId,
            comparisonProfileId: clock.comparisonProfileId,
            baselines: [...clock.baselines],
            epochs: [...clock.epochs],
          },
    rasterTolerancePx: RENDER_TRANSFORM_CSS_TOLERANCE_PX,
    requiredEvidence: sortStrings(contract.requiredEvidence),
    toleranceRefs: sortStrings(contract.toleranceRefs),
    visualRefs: sortStrings(contract.visualRefs),
    normalizationRef: contract.normalizationRef,
  };
}

function actualPayload(
  contract: ResolvedCheckContract,
  facts: CrosswordKernelFacts,
  authority: ExecutionAuthority,
  fact: CrosswordEvaluatorFact | null,
  evidence: EvidenceConsumption,
  status: CheckResultStatus,
  authorityState: CrosswordAuthorityState,
): Record<string, unknown> {
  const current = authority.state === 'current';
  return {
    schema: contract.actualSchema,
    status,
    authority: authorityState,
    executionAuthority: authority.state,
    children: projectChildren(Array.isArray(facts.executions) ? facts.executions : []),
    comparison: current
      ? compareCrosswordExecutionsFromAuthority(authority)
      : (facts.comparison ?? null),
    oracle: {
      authority: fact === null ? null : fact.authority,
      currentness: fact === null ? null : fact.currentness,
      sourcesAgree: fact === null ? null : fact.sourcesAgree,
      mismatch: fact === null ? null : fact.mismatch,
    },
    oracleFacts:
      facts.oracleFacts === null
        ? null
        : {
            authority: facts.oracleFacts.authority,
            sourceAgreement: facts.oracleFacts.sourceAgreement,
            comparison:
              facts.oracleFacts.comparison === null || facts.oracleFacts.comparison === undefined
                ? null
                : {
                    sameSeedPair: facts.oracleFacts.comparison.sameSeedPair === true,
                    differentSeedPair: facts.oracleFacts.comparison.differentSeedPair === true,
                    repeatIdentical: facts.oracleFacts.comparison.repeatIdentical === true,
                    seedSensitivity: facts.oracleFacts.comparison.seedSensitivity === true,
                    collision: facts.oracleFacts.comparison.collision === true,
                    wordsEqualAcrossChildren:
                      facts.oracleFacts.comparison.wordsEqualAcrossChildren === true,
                    distinctDocuments: facts.oracleFacts.comparison.distinctDocuments === true,
                  },
            clockEpochs: Array.isArray(facts.oracleFacts.clockEpochs)
              ? [...facts.oracleFacts.clockEpochs]
              : null,
            currentnessDistinct: facts.oracleFacts.currentnessDistinct === true,
            rasterCurrent: facts.oracleFacts.rasterCurrent === true,
            checks: Array.isArray(facts.oracleFacts.checks)
              ? facts.oracleFacts.checks.map((entry) => ({
                  checkId: stringOrNull(entry.checkId),
                  predicateMet: entry.predicateMet === true,
                }))
              : [],
          },
    diagnosticCodes: Array.isArray(facts.diagnostics)
      ? facts.diagnostics
          .map((entry) => (isPlainRecord(entry) ? stringOrNull(entry.code) : null))
          .filter((entry): entry is string => entry !== null)
      : [],
    consumedEvidence: sortStrings(evidence.consumed),
  };
}

/** Recomputes the accepted A1/A2/B comparison from the validated children. */
function compareCrosswordExecutionsFromAuthority(
  authority: ExecutionAuthority,
): CrosswordThreeChildComparison | null {
  if (authority.executions.length !== CROSSWORD_EXECUTION_ROLES.length) return null;
  const byRole = new Map(authority.executions.map((child) => [child.executionRole, child]));
  const a1 = byRole.get('A1');
  const a2 = byRole.get('A2');
  const b = byRole.get('B');
  if (a1 === undefined || a2 === undefined || b === undefined) return null;
  return compareCrosswordExecutions({
    a1: { words: a1.words, seed: a1.actualSeed, semanticDigest: a1.semanticDigest },
    a2: { words: a2.words, seed: a2.actualSeed, semanticDigest: a2.semanticDigest },
    b: { words: b.words, seed: b.actualSeed, semanticDigest: b.semanticDigest },
  });
}

function buildCheckResult(
  profile: ResolvedCorrectnessProfile,
  actionCycle: ActionCycleCorrectnessIdentity,
  contract: ResolvedCheckContract,
  status: CheckResultStatus,
  expected: Record<string, unknown>,
  actual: Record<string, unknown>,
  consumedEvidence: readonly string[],
): CorrectnessCheckResult {
  return {
    schemaVersion: CHECK_RESULT_CONTRACT_SCHEMA_VERSION,
    checkId: contract.checkId,
    status,
    expected,
    actual,
    evidenceIds: sortStrings(consumedEvidence),
    toleranceRefs: sortStrings(contract.toleranceRefs),
    visualRefs: sortStrings(contract.visualRefs),
    normalizationRef: contract.normalizationRef,
    actionCycleRef: actionCycle.actionCycleId,
    consumedComponentFingerprints: consumedFingerprints(profile),
  };
}

/**
 * The exact trust mapping for one declared check.
 *
 * A trustworthy product mismatch (seed epoch, word/layout, repeat stability,
 * seed sensitivity/collision, raster region non-convergence) after valid,
 * current, interpretable authority is `FAIL`; a missing, stale, torn, malformed,
 * wrong-target, or non-authoritative execution/raster/source authority, an
 * absent or legacy-shaped accepted fact, or a non-authoritative required
 * evidence role is `UNUSABLE`.
 */
function resolveStatus(
  authority: ExecutionAuthority,
  fact: CrosswordEvaluatorFact | null,
  evidence: EvidenceConsumption,
): { status: CheckResultStatus; authority: CrosswordAuthorityState } {
  if (authority.state !== 'current') {
    return { status: 'UNUSABLE', authority: authority.state };
  }
  if (fact === null || !isWellFormedEvaluatorFact(fact)) {
    return { status: 'UNUSABLE', authority: 'missing' };
  }
  if (!evidence.authoritative) {
    return { status: 'UNUSABLE', authority: evidence.authorityState };
  }
  if (fact.authority !== 'current') {
    return { status: 'UNUSABLE', authority: fact.authority };
  }
  return { status: fact.mismatch ? 'FAIL' : 'PASS', authority: 'current' };
}

function runCrosswordKernel(input: CrosswordKernelInput): CrosswordKernelResult {
  const { profile, route, actionCycle, facts } = input;
  const issues = validateProfile(profile, route, actionCycle);
  if (issues.length > 0) {
    return { kind: CROSSWORD_KERNEL_EVALUATOR, ok: false, checks: [], issues };
  }

  if (facts.evaluator !== CROSSWORD_KERNEL_EVALUATOR) {
    issues.push(
      issue(
        'CROSSWORD_KERNEL_FACTS_EVALUATOR_MISMATCH',
        `Crossword facts declare evaluator "${String(facts.evaluator)}" instead of "${CROSSWORD_KERNEL_EVALUATOR}".`,
      ),
    );
  }

  validateCheckFacts(profile, facts, issues);
  const authority = readExecutionAuthority(facts);
  if (authority.state !== 'current') {
    issues.push(
      issue(
        'CROSSWORD_KERNEL_EXECUTION_AUTHORITY_UNUSABLE',
        `The accepted Crossword execution authority is ${authority.state}: ${authority.detail}`,
      ),
    );
    if (authority.state === 'stale') {
      issues.push(issue('CROSSWORD_KERNEL_SOURCE_DRIFT', authority.detail));
    }
  }

  const factById = new Map<string, CrosswordEvaluatorFact>();
  for (const fact of Array.isArray(facts.checks) ? facts.checks : []) {
    if (
      isPlainRecord(fact) &&
      typeof fact.checkId === 'string' &&
      isWellFormedEvaluatorFact(fact) &&
      !factById.has(fact.checkId)
    ) {
      factById.set(fact.checkId, fact as unknown as CrosswordEvaluatorFact);
    }
  }

  const checks: CorrectnessCheckResult[] = [];
  for (const contract of profile.requiredChecks) {
    const evidence = consumeRequiredEvidence(
      contract,
      profile,
      Array.isArray(facts.evidence) ? facts.evidence : [],
      issues,
    );
    const fact = factById.get(contract.checkId) ?? null;
    if (fact === null && authority.state === 'current') {
      issues.push(
        issue(
          'CROSSWORD_KERNEL_FACT_CHECK_MISSING',
          `No accepted Crossword evaluator fact exists for declared check "${contract.checkId}".`,
          contract.checkId,
        ),
      );
    }
    const resolved = resolveStatus(authority, fact, evidence);
    checks.push(
      buildCheckResult(
        profile,
        actionCycle,
        contract,
        resolved.status,
        expectedPayload(profile, contract, facts, authority.clock),
        actualPayload(
          contract,
          facts,
          authority,
          fact,
          evidence,
          resolved.status,
          resolved.authority,
        ),
        evidence.consumed,
      ),
    );
  }

  return { kind: CROSSWORD_KERNEL_EVALUATOR, ok: true, checks, issues };
}

/**
 * The Crossword generation/determinism final kernel. It evaluates the profile's
 * declared Crossword checks from the accepted Oracle, clock, execution, raster,
 * source, and evidence facts.
 */
export function evaluateCrosswordChecks(input: CrosswordKernelInput): CrosswordKernelResult {
  return runCrosswordKernel(input);
}

/** Runtimes dispatch to exactly one Crossword kernel kind. */
export function crosswordKernelKindForEvaluator(
  evaluatorKind: string | null | undefined,
): CrosswordKernelKind | null {
  return evaluatorKind === CROSSWORD_KERNEL_EVALUATOR ? CROSSWORD_KERNEL_EVALUATOR : null;
}
