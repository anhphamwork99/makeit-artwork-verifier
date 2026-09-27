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
import type { Capability } from '../contracts/discriminants';
import {
  RESTORE_OBSERVATION_SCHEMA_VERSION,
  RESTORE_SAVE_CONTROL,
  resolveRestoreSetupRecipe,
  type RestoreMeaningFactView,
  type RestoreRawSemanticFactView,
  type RestoreTransitionFactView,
} from '../contracts/restore-observation';
import { isPlainRecord } from '../contracts/result-agreement';
import {
  CHECK_RESULT_CONTRACT_SCHEMA_VERSION,
  RESOLVED_CORRECTNESS_PROFILE_SCHEMA_VERSION,
} from '../contracts/schema-versions';

/**
 * P7-B B1-F2 inactive final compiled-profile kernel for frontend
 * serialize/restore (ADR 0028 §3 B1-F; the restore half).
 *
 * The frontend serialize/restore capability is proven by the accepted
 * `frontend-restore` Oracle (WP5 Slice 5-F; ADR 0019 R5–R7/R9; ADR 0021 N1/N7).
 * One whole-document Action Cycle chain constructs the source document through
 * seller-visible controls, performs the native `Save` (capturing the exact
 * `POST` body), follows the product redirect, fulfills the exact `GET`, and
 * resolves the two declared checks (`serialize.roundtrip`,
 * `serialize.raw-semantic`).
 *
 * This kernel is the *inactive final* consumer of those facts. It receives
 * exactly the compiled `ResolvedCorrectnessProfile`, the route the runtime
 * resolved, the Action Cycle correctness identity that observed the whole
 * document round trip, and the accepted WP5f restore facts:
 *
 *  1. the accepted Oracle execution facts — the exact transition view, the
 *     normalized-meaning view, and the raw-semantics view validated here
 *     against the accepted restore observation contract so a missing, stale,
 *     torn, ambiguous, malformed, or wrong-target authority is unusable even
 *     when a delivered boolean fact claims otherwise;
 *  2. the accepted coherent source/restored document observations
 *     (`restore.source-snapshot`/`restore.restored-snapshot`) with their
 *     document/epoch/bridge-generation/revision currentness, serialized and
 *     restored object structure, and selection/viewport editor state;
 *  3. the accepted readiness policy and observation the whole-document Action
 *     Cycle chain obeyed (one non-extending `FRONTEND_RESTORE_V1` deadline);
 *  4. the delivered structured per-check evaluator facts (authority,
 *     currentness, source-correlation, and product-mismatch), the accepted
 *     Oracle's raw named primitive fact projection, and the delivered
 *     diagnostics; and
 *  5. the observed evidence roles for the whole-document Action Cycle chain.
 *
 * It returns one complete, field-rich `CorrectnessCheckResult` per declared
 * required check — or, when the compiled profile itself is not trustworthy, no
 * fabricated checks at all.
 *
 * Every correctness input is read from the compiled profile. This module owns no
 * required-check list, no check id, no tolerance/visual/normalization literal,
 * no deadline policy, no fallback id, and no Subject-name/family/scenario
 * branch; it never reloads an authoring catalogue. The accepted frontend
 * serialize/restore meaning is preserved exactly:
 *
 *  - a trustworthy product mismatch (a well-formed false transition/meaning/
 *     raw-semantics fact) after valid, current, interpretable authority is
 *     `FAIL`;
 *  - missing / stale / torn / ambiguous / malformed / wrong-target pre-action,
 *     target, execution, or readiness authority — or a non-current structured
 *     per-check evaluator authority — is `UNUSABLE`;
 *  - a diagnostic-only item can never rescue a required check.
 *
 * The pre-action baseline is the authoritative source observation: the exact
 * coherent `restore.source-snapshot` and every delivered meaning/raw fact must
 * correlate with it (ADR 0027 §3.2 B-R2's fail-closed pre-action authority,
 * applied to the restore round trip), and the restored target must be a
 * genuinely distinct current document. Authority that cannot be correlated is
 * never dispatched into a passing check.
 *
 * The kernel is deliberately inactive. Nothing here is imported by the active
 * executor, Oracle, classifier, writer, or CLI, and no module under `src/runtime`
 * or `src/oracles` is imported in return: the fact contract below is
 * structurally satisfied by the accepted `RestoreOracleFacts` projection, the
 * accepted `PublicRestoreEvidenceV1` source/restored/route facts, and the
 * accepted drive readiness/currentness facts, so the atomic B2 cutover can pass
 * the delivered facts in without this module depending on active machinery.
 */

/** The single delivered frontend serialize/restore evaluator family this kernel owns. */
export const RESTORE_KERNEL_KINDS = ['frontend-restore'] as const;
export type RestoreKernelKind = (typeof RESTORE_KERNEL_KINDS)[number];

/** The compiled Oracle discriminant the restore route resolves. */
export const RESTORE_KERNEL_EVALUATOR = 'frontend-restore';

/**
 * The closed per-check evaluator discriminants the `frontend-restore` Oracle
 * declares. A compiled profile that declares a different check evaluator cannot
 * be interpreted by this kernel.
 */
export const RESTORE_KERNEL_CHECK_EVALUATORS = ['frontend-restore'] as const;

/**
 * Closed evidence-availability vocabulary. Only `authoritative` evidence is
 * current and interpretable; every other state makes a required check
 * `UNUSABLE`. `diagnostic-only` is the single role that must never satisfy a
 * required check.
 */
export const RESTORE_EVIDENCE_AVAILABILITY = [
  'authoritative',
  'ambiguous',
  'diagnostic-only',
  'malformed',
  'missing',
  'stale',
  'torn',
] as const;
export type RestoreEvidenceAvailability = (typeof RESTORE_EVIDENCE_AVAILABILITY)[number];

export function isRestoreEvidenceAvailability(
  value: unknown,
): value is RestoreEvidenceAvailability {
  return (
    typeof value === 'string' &&
    (RESTORE_EVIDENCE_AVAILABILITY as readonly string[]).includes(value)
  );
}

/** One accepted evidence fact the whole-document Action Cycle chain observed. */
export interface RestoreEvidenceFact {
  readonly evidenceId: string;
  readonly availability: RestoreEvidenceAvailability;
}

/** Closed authority state recorded in every `actual` interpretation. */
export const RESTORE_AUTHORITY_STATES = [
  'ambiguous',
  'current',
  'malformed',
  'missing',
  'stale',
  'torn',
  'unavailable',
  'wrong-target',
] as const;
export type RestoreAuthorityState = (typeof RESTORE_AUTHORITY_STATES)[number];

/**
 * The authority scope the kernel refuses. It distinguishes the pre-action source
 * arm, the restored target arm, the structural execution arm, and the readiness
 * gate, so a precise structured issue names the failing authority without
 * inventing a check.
 */
/**
 * Closed structured currentness vocabulary for one accepted evaluator fact
 * (ADR 0029 §4 B2-B). Currentness is an explicit structured fact recorded per
 * check; it is never a final result status.
 */
export const RESTORE_FACT_CURRENTNESS = ['current', 'stale', 'torn', 'unavailable'] as const;
export type RestoreFactCurrentness = (typeof RESTORE_FACT_CURRENTNESS)[number];

/** Projects a structured authority state onto the closed currentness domain. */
export function restoreCurrentnessForAuthority(
  authority: RestoreAuthorityState,
): RestoreFactCurrentness {
  if (authority === 'current') return 'current';
  if (authority === 'stale') return 'stale';
  if (authority === 'torn') return 'torn';
  return 'unavailable';
}

function isRestoreAuthorityState(value: unknown): value is RestoreAuthorityState {
  return (
    typeof value === 'string' && (RESTORE_AUTHORITY_STATES as readonly string[]).includes(value)
  );
}

function isRestoreFactCurrentness(value: unknown): value is RestoreFactCurrentness {
  return (
    typeof value === 'string' && (RESTORE_FACT_CURRENTNESS as readonly string[]).includes(value)
  );
}

export const RESTORE_AUTHORITY_SCOPES = ['execution', 'pre-action', 'readiness', 'target'] as const;
export type RestoreAuthorityScope = (typeof RESTORE_AUTHORITY_SCOPES)[number];

/** Closed signal-first readiness outcomes for the whole-document round trip. */
export const RESTORE_READINESS_OUTCOMES = [
  'invalidated',
  'signal',
  'stale',
  'timeout',
  'unavailable',
] as const;
export type RestoreReadinessOutcome = (typeof RESTORE_READINESS_OUTCOMES)[number];

export function isRestoreReadinessOutcome(value: unknown): value is RestoreReadinessOutcome {
  return (
    typeof value === 'string' && (RESTORE_READINESS_OUTCOMES as readonly string[]).includes(value)
  );
}

/** The compiled readiness policy the whole-document chain applied. */
export interface RestoreReadinessPolicyFact {
  readonly profileId: string;
  readonly deadlineCategory: string;
  readonly deadlineMs: number;
  readonly signalWatchdogMs: number;
  readonly fallbackCadenceMs: readonly number[];
  readonly stableFrames: number;
  readonly quiescenceRequired: boolean;
  readonly stableFrameRequired: boolean;
}

/** The observed signal-first readiness execution of the round-trip chain. */
export interface RestoreReadinessObservationFact {
  readonly outcome: RestoreReadinessOutcome;
  readonly wakeSource: string | null;
  readonly fallbackPollCount: number;
  readonly watchdogWaits: number;
  readonly observedStableFrames: number | null;
  readonly detail: string | null;
}

/** Accepted readiness facts: the compiled policy plus the observed execution. */
export interface RestoreReadinessFact {
  readonly policy: RestoreReadinessPolicyFact;
  readonly observation: RestoreReadinessObservationFact;
}

/** Optional environment viewport attached to one document observation. */
export interface RestoreViewportFact {
  readonly widthCss: number;
  readonly heightCss: number;
  readonly devicePixelRatio: number;
}

/**
 * One accepted coherent document observation (the serialized source or the
 * restored target). `selection`/`viewport` are editor-only state that the
 * normalized meaning deliberately excludes (ADR 0019 R6 / design §4.3): they are
 * carried for a field-rich `actual` and validated when present, but they are
 * never a required-check authority and are never fabricated.
 */
export interface RestoreDocumentObservationFact {
  readonly documentId: string;
  readonly documentEpoch: number;
  readonly route: string;
  readonly observationId: string;
  readonly observationRevision: number;
  readonly bridgeGeneration: number;
  readonly normalizedFingerprint: string;
  readonly canonicalDigest: string;
  readonly layoutCount: number;
  readonly layerCount: number;
  readonly historyPastDepth: number;
  readonly historyFutureDepth: number;
  readonly historyBaselineClean: boolean;
  readonly activeLayoutId?: string | null;
  readonly selectedLayerIds?: readonly string[] | null;
  readonly viewport?: RestoreViewportFact | null;
}

/** One accepted restore setup checkpoint from the source-construction recipes. */
export interface RestoreSetupCheckpointFact {
  readonly role: string;
  readonly stepCount: number;
  readonly historyPastDepth: number;
  readonly historyFutureDepth: number;
  readonly historyBaselineClean: boolean;
  readonly meaningFingerprint: string;
}

/**
 * One accepted per-check restore evaluator fact in explicit structured form
 * (ADR 0029 §4 B2-B). The legacy boolean `passed` is replaced by structured
 * authority, currentness, source-correlation, and product-mismatch facts so the
 * kernel maps them to a status from explicit structure instead of translating
 * a boolean check result. The facts are supplied by the inactive B2-B5
 * live-fact adapter from the delivered Restore Oracle observations; this module
 * owns no predicate policy of its own.
 */
export interface RestoreEvaluatorFact {
  readonly checkId: string;
  /** Structured authority state of the accepted evaluator fact. */
  readonly authority: RestoreAuthorityState;
  /** Structured currentness of the accepted evaluator fact. */
  readonly currentness: RestoreFactCurrentness;
  /** Whether the independent raw source/restored observations agreed. */
  readonly sourcesAgree: boolean;
  /** A trustworthy product mismatch under a current authority. */
  readonly mismatch: boolean;
}

/** One raw primitive per-check predicate of the accepted Restore Oracle. */
export interface RestorePrimitiveCheckFactView {
  readonly checkId: string;
  readonly predicateMet: boolean;
}

/**
 * The additive named primitive Restore Oracle facts the inactive B2-B5 adapter
 * consumed. Every field is a raw primitive observation (a structured authority,
 * the independent source/restored correlation primitive, the raw accepted
 * transition/normalized-meaning/raw-semantics views, and one predicate per
 * selected check); no field is a legacy composite boolean check result or an
 * aggregate harness flag. A malformed evaluation carries no readable primitive
 * view at all.
 */
export interface RestoreOracleFactsView {
  readonly authority: 'current' | 'malformed';
  readonly schemaVersion: number;
  /** The raw source/restored document correlation primitive. */
  readonly sourceAgreement: boolean;
  readonly transition: RestoreTransitionFactView | null;
  readonly meaning: RestoreMeaningFactView | null;
  readonly rawSemantics: RestoreRawSemanticFactView | null;
  readonly checks: readonly RestorePrimitiveCheckFactView[];
}

/** The route a kernel is asked to evaluate. Passed in; never selected internally. */
export interface RestoreKernelRoute {
  readonly subjectId: string;
  readonly capability: Capability;
  readonly variant: string | null;
}

/** Defensive projection of one raw accepted setup checkpoint, for `actual`. */
export interface RestoreKernelSetupProjection {
  readonly role: string | null;
  readonly stepCount: number | null;
  readonly historyPastDepth: number | null;
  readonly historyFutureDepth: number | null;
  readonly historyBaselineClean: boolean | null;
  readonly baselineCleanProductExact: boolean | null;
  readonly meaningFingerprint: string | null;
  readonly declaredRecipe: boolean | null;
}

/** Defensive projection of one raw accepted document observation, for `actual`. */
export interface RestoreKernelDocumentProjection {
  readonly documentId: string | null;
  readonly documentEpoch: number | null;
  readonly route: string | null;
  readonly observationId: string | null;
  readonly observationRevision: number | null;
  readonly bridgeGeneration: number | null;
  readonly normalizedFingerprint: string | null;
  readonly canonicalDigest: string | null;
  readonly layoutCount: number | null;
  readonly layerCount: number | null;
  readonly history: {
    readonly pastDepth: number | null;
    readonly futureDepth: number | null;
    readonly baselineClean: boolean | null;
  };
  readonly activeLayoutId: string | null;
  readonly selectedLayerIds: readonly string[] | null;
  readonly viewport: {
    readonly widthCss: number | null;
    readonly heightCss: number | null;
    readonly devicePixelRatio: number | null;
  } | null;
}

/**
 * Accepted frontend serialize/restore facts: the exact transition/meaning/
 * raw-semantics Oracle views, the coherent source/restored document
 * observations, the source-construction setup checkpoints, the readiness
 * policy/observation, the delivered structured per-check evaluator facts, the
 * accepted Oracle's raw named primitive fact projection, the delivered
 * diagnostics, and the observed evidence roles. `setup` and `diagnostics` are
 * typed `unknown` so the kernel validates them through the accepted observation
 * contract rather than trusting a caller-supplied shape.
 *
 * The legacy aggregate `harnessInvalid` flag and the legacy per-check boolean
 * `passed` are deliberately absent (ADR 0029 §4 B2-B): `checks` carries the
 * explicit structured authority/currentness/source-correlation/mismatch facts
 * for every declared check, and `oracleFacts` carries the accepted Oracle's raw
 * named primitive fact projection. No boolean check result is translated into
 * a final status.
 */
export interface RestoreKernelFacts {
  readonly evaluator: typeof RESTORE_KERNEL_EVALUATOR;
  readonly schemaVersion: number;
  readonly transition: RestoreTransitionFactView;
  readonly meaning: RestoreMeaningFactView;
  readonly rawSemantics: RestoreRawSemanticFactView;
  readonly source: unknown;
  readonly restored: unknown;
  readonly setup: readonly unknown[];
  readonly readiness: RestoreReadinessFact;
  readonly checks: readonly RestoreEvaluatorFact[];
  /** The raw named primitive Restore Oracle facts, or `null` when none ran. */
  readonly oracleFacts: RestoreOracleFactsView | null;
  readonly diagnostics: readonly { readonly code: string; readonly detail: string }[];
  readonly evidence: readonly RestoreEvidenceFact[];
}

/** Closed kernel issue vocabulary; deliberately local to the inactive kernel. */
export const RESTORE_KERNEL_ISSUE_CODES = [
  'RESTORE_KERNEL_PROFILE_NOT_OBJECT',
  'RESTORE_KERNEL_PROFILE_SCHEMA_UNSUPPORTED',
  'RESTORE_KERNEL_PROFILE_FINGERPRINT_MISSING',
  'RESTORE_KERNEL_PROFILE_FINGERPRINT_INVALID',
  'RESTORE_KERNEL_PROFILE_FINGERPRINT_MISMATCH',
  'RESTORE_KERNEL_COMPONENT_FINGERPRINT_INVALID',
  'RESTORE_KERNEL_ROUTE_MISMATCH',
  'RESTORE_KERNEL_ORACLE_EVALUATOR_UNSUPPORTED',
  'RESTORE_KERNEL_CHECK_EVALUATOR_UNSUPPORTED',
  'RESTORE_KERNEL_REQUIRED_CHECK_MISSING',
  'RESTORE_KERNEL_REQUIRED_CHECK_DUPLICATE',
  'RESTORE_KERNEL_EMPTY_REQUIRED_CHECKS',
  'RESTORE_KERNEL_ACTION_CYCLE_MISMATCH',
  'RESTORE_KERNEL_READINESS_MISMATCH',
  'RESTORE_KERNEL_NORMALIZATION_MISMATCH',
  'RESTORE_KERNEL_FACTS_SCHEMA_UNSUPPORTED',
  'RESTORE_KERNEL_FACTS_EVALUATOR_MISMATCH',
  'RESTORE_KERNEL_TRANSITION_SHAPE_UNINTERPRETABLE',
  'RESTORE_KERNEL_MEANING_SHAPE_UNINTERPRETABLE',
  'RESTORE_KERNEL_RAW_SEMANTIC_SHAPE_UNINTERPRETABLE',
  'RESTORE_KERNEL_SOURCE_OBSERVATION_UNINTERPRETABLE',
  'RESTORE_KERNEL_RESTORED_OBSERVATION_UNINTERPRETABLE',
  'RESTORE_KERNEL_FACT_CHECK_MISSING',
  'RESTORE_KERNEL_FACT_CHECK_UNKNOWN',
  'RESTORE_KERNEL_FACT_CHECK_DUPLICATE',
  'RESTORE_KERNEL_FACT_STATUS_UNKNOWN',
  'RESTORE_KERNEL_FACT_AUTHORITY_UNKNOWN',
  'RESTORE_KERNEL_TARGET_AUTHORITY_UNUSABLE',
  'RESTORE_KERNEL_READINESS_AUTHORITY_UNUSABLE',
  'RESTORE_KERNEL_READINESS_POLICY_MISMATCH',
  'RESTORE_KERNEL_PRE_ACTION_AUTHORITY_UNUSABLE',
  'RESTORE_KERNEL_EXECUTION_AUTHORITY_UNUSABLE',
  'RESTORE_KERNEL_EVIDENCE_UNDECLARED',
  'RESTORE_KERNEL_EVIDENCE_DIAGNOSTIC_ONLY',
] as const;
export type RestoreKernelIssueCode = (typeof RESTORE_KERNEL_ISSUE_CODES)[number];

export interface RestoreKernelIssue {
  readonly code: RestoreKernelIssueCode;
  readonly detail: string;
  readonly checkId: string | null;
}

export interface RestoreKernelResult {
  readonly kind: RestoreKernelKind;
  /**
   * `true` when the compiled profile was trustworthy and a complete check
   * result was produced for every declared check (possibly all `UNUSABLE`).
   * `false` when the profile itself failed validation; `checks` is then empty
   * because no trustworthy check may be fabricated from an invalid profile.
   */
  readonly ok: boolean;
  readonly checks: readonly CorrectnessCheckResult[];
  readonly issues: readonly RestoreKernelIssue[];
}

export interface RestoreKernelInput {
  readonly profile: ResolvedCorrectnessProfile;
  readonly route: RestoreKernelRoute;
  readonly actionCycle: ActionCycleCorrectnessIdentity;
  readonly facts: RestoreKernelFacts;
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

/** Exact field names of the accepted transition view, for the expected payload. */
const TRANSITION_FACT_FIELDS = [
  'createAfterEpoch',
  'createContentTypeMatches',
  'createMethodMatches',
  'createPathMatches',
  'createRequestCount',
  'documentIdentityDistinct',
  'getMethodMatches',
  'getPathMatches',
  'getRequestCount',
  'harnessHydrateCalls',
  'harnessStoreMutationCalls',
  'navigateRouteMatches',
  'redirectObserved',
  'restoredHistoryClean',
  'saveDispatchedOnce',
] as const;

/** Exact field names of the accepted meaning view, for the expected payload. */
const MEANING_FACT_FIELDS = [
  'inventoryPreserved',
  'normalizedFingerprintEqual',
  'normalizedStructurallyEqual',
  'persistenceLossDetected',
  'restoredFingerprint',
  'sourceFingerprint',
] as const;

/** Exact field names of the accepted raw-semantics view, for the expected payload. */
const RAW_SEMANTIC_FACT_FIELDS = [
  'crosswordPresent',
  'generationSeed',
  'layoutDigest',
  'normalizedHasNoConfigKey',
  'normalizedHasNoIdKey',
  'normalizedHasNoServerMetadata',
  'rawConfigPresent',
  'rawServerMetadataPresent',
  'restoredLayoutDigestMatches',
  'restoredSeedMatches',
  'restoredWordsMatch',
  'volatileIdsDiffer',
  'words',
] as const;

/** The product-exact clean baseline position (`past === 0 && future === 0`). */
function productBaselineClean(pastDepth: number, futureDepth: number): boolean {
  return pastDepth === 0 && futureDepth === 0;
}

function issue(
  code: RestoreKernelIssueCode,
  detail: string,
  checkId: string | null = null,
): RestoreKernelIssue {
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

function integerOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

function booleanOrNull(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
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
 * Validates that the compiled profile is exactly the immutable frontend
 * serialize/restore profile for the requested route and that the Action Cycle
 * observed the same profile. It also validates the applicable normalization
 * closure (ADR 0028 §2: `normalizationRef:null` is valid only for the explicit
 * non-applicable state). Every failure is fail-closed and reported as a
 * structured issue; the fingerprint is independently recomputed from the
 * profile content so a mutated compiled field is detected rather than trusted.
 */
function validateProfile(
  profile: ResolvedCorrectnessProfile,
  route: RestoreKernelRoute,
  actionCycle: ActionCycleCorrectnessIdentity,
): RestoreKernelIssue[] {
  const issues: RestoreKernelIssue[] = [];
  if (!isPlainRecord(profile)) {
    issues.push(
      issue('RESTORE_KERNEL_PROFILE_NOT_OBJECT', 'The compiled profile is not a plain object.'),
    );
    return issues;
  }
  if (profile.schemaVersion !== RESOLVED_CORRECTNESS_PROFILE_SCHEMA_VERSION) {
    issues.push(
      issue(
        'RESTORE_KERNEL_PROFILE_SCHEMA_UNSUPPORTED',
        `Resolved-profile schema ${String(profile.schemaVersion)} is not supported.`,
      ),
    );
  }

  const storedFingerprint = profile.resolvedFingerprint;
  if (storedFingerprint === undefined || storedFingerprint === null) {
    issues.push(
      issue(
        'RESTORE_KERNEL_PROFILE_FINGERPRINT_MISSING',
        'The compiled profile carries no resolved fingerprint.',
      ),
    );
  } else if (!isFullCanonicalFingerprint(storedFingerprint)) {
    issues.push(
      issue(
        'RESTORE_KERNEL_PROFILE_FINGERPRINT_INVALID',
        'The compiled resolved fingerprint is not a full canonical 64-hex identity.',
      ),
    );
  } else {
    const preimage = Object.fromEntries(
      Object.entries(profile).filter(([key]) => key !== 'resolvedFingerprint'),
    ) as unknown as Omit<ResolvedCorrectnessProfile, 'resolvedFingerprint'>;
    let derived: string | null = null;
    try {
      derived = deriveResolvedCorrectnessProfileFingerprint(preimage);
    } catch {
      derived = null;
    }
    if (derived !== storedFingerprint) {
      issues.push(
        issue(
          'RESTORE_KERNEL_PROFILE_FINGERPRINT_MISMATCH',
          derived === null
            ? 'The compiled resolved fingerprint could not be recomputed from the profile content (non-canonicalizable field).'
            : 'The compiled resolved fingerprint does not match the profile content; a compiled field was mutated.',
        ),
      );
    }
  }

  const componentFingerprints = profile.componentFingerprints;
  if (!isPlainRecord(componentFingerprints)) {
    issues.push(
      issue(
        'RESTORE_KERNEL_COMPONENT_FINGERPRINT_INVALID',
        'The compiled profile carries no component fingerprints.',
      ),
    );
  } else {
    for (const field of COMPONENT_FINGERPRINT_FIELDS) {
      if (!isFullCanonicalFingerprint(componentFingerprints[field])) {
        issues.push(
          issue(
            'RESTORE_KERNEL_COMPONENT_FINGERPRINT_INVALID',
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
        'RESTORE_KERNEL_ROUTE_MISMATCH',
        `Compiled profile route ${profile.subjectId}×${String(profile.capability)}@${profile.variant ?? '∅'} does not equal the requested route ${route.subjectId}×${String(route.capability)}@${route.variant ?? '∅'}.`,
      ),
    );
  }

  const oracle: unknown = profile.oracle;
  if (!isPlainRecord(oracle) || oracle.evaluatorKind !== RESTORE_KERNEL_EVALUATOR) {
    const found = isPlainRecord(oracle) ? String(oracle.evaluatorKind) : 'undefined';
    issues.push(
      issue(
        'RESTORE_KERNEL_ORACLE_EVALUATOR_UNSUPPORTED',
        `Compiled Oracle evaluator "${found}" is not supported by this frontend restore kernel (expected "${RESTORE_KERNEL_EVALUATOR}").`,
      ),
    );
  }

  const requiredChecks = Array.isArray(profile.requiredChecks) ? profile.requiredChecks : [];
  if (requiredChecks.length === 0) {
    issues.push(
      issue(
        'RESTORE_KERNEL_EMPTY_REQUIRED_CHECKS',
        'A compiled profile with no declared required check cannot produce a check result.',
      ),
    );
  }
  const seen = new Set<string>();
  const normalization = profile.normalization;
  const normalizationApplicable = isPlainRecord(normalization) && normalization.applicable === true;
  const normalizationId =
    normalizationApplicable && typeof normalization.normalizationId === 'string'
      ? normalization.normalizationId
      : null;
  for (const check of requiredChecks) {
    const checkId = typeof check.checkId === 'string' ? check.checkId : null;
    if (checkId === null) {
      issues.push(
        issue(
          'RESTORE_KERNEL_REQUIRED_CHECK_MISSING',
          'A declared required check has no check id.',
        ),
      );
      continue;
    }
    if (seen.has(checkId)) {
      issues.push(
        issue(
          'RESTORE_KERNEL_REQUIRED_CHECK_DUPLICATE',
          `Declared required check "${checkId}" appears more than once.`,
          checkId,
        ),
      );
      continue;
    }
    seen.add(checkId);
    if (
      typeof check.evaluator !== 'string' ||
      !(RESTORE_KERNEL_CHECK_EVALUATORS as readonly string[]).includes(check.evaluator)
    ) {
      issues.push(
        issue(
          'RESTORE_KERNEL_CHECK_EVALUATOR_UNSUPPORTED',
          `Required check "${checkId}" declares evaluator "${String(check.evaluator)}" which this frontend restore kernel does not support.`,
          checkId,
        ),
      );
    }
    // Normalization closure: a check that declares a normalization reference
    // requires the compiled explicit applicable declaration to carry that exact
    // identity; a check with no reference requires the explicit non-applicable
    // variant. Neither side is ever defaulted.
    if (check.normalizationRef === null) {
      if (normalizationApplicable) {
        issues.push(
          issue(
            'RESTORE_KERNEL_NORMALIZATION_MISMATCH',
            `Required check "${checkId}" declares no normalization reference but the compiled profile carries an applicable normalization declaration.`,
            checkId,
          ),
        );
      }
    } else if (!normalizationApplicable || normalizationId !== check.normalizationRef) {
      issues.push(
        issue(
          'RESTORE_KERNEL_NORMALIZATION_MISMATCH',
          `Required check "${checkId}" declares normalization reference "${check.normalizationRef}" which the compiled normalization declaration does not provide.`,
          checkId,
        ),
      );
    }
  }

  if (actionCycle.resolvedProfileFingerprint !== storedFingerprint) {
    issues.push(
      issue(
        'RESTORE_KERNEL_ACTION_CYCLE_MISMATCH',
        'The Action Cycle resolved-profile fingerprint does not equal the compiled profile fingerprint.',
      ),
    );
  }
  if (actionCycle.readinessFingerprint !== profile.componentFingerprints?.readiness) {
    issues.push(
      issue(
        'RESTORE_KERNEL_READINESS_MISMATCH',
        'The Action Cycle readiness fingerprint does not equal the compiled readiness component.',
      ),
    );
  }
  return issues;
}

// ── Accepted execution/target/readiness authority ────────────────────────────

interface AuthorityFinding {
  readonly state: RestoreAuthorityState;
  readonly scope: RestoreAuthorityScope;
  readonly detail: string;
  /** A precise companion issue code for the failing authority surface. */
  readonly code?: RestoreKernelIssueCode;
}

interface AuthorityClassification {
  readonly state: RestoreAuthorityState;
  readonly scope: RestoreAuthorityScope | null;
  readonly detail: string;
  readonly code: RestoreKernelIssueCode | null;
  readonly findings: readonly AuthorityFinding[];
}

interface DocumentObservationReading {
  readonly documentId: string;
  readonly documentEpoch: number;
  readonly route: string;
  readonly observationId: string;
  readonly observationRevision: number;
  readonly bridgeGeneration: number;
  readonly normalizedFingerprint: string;
  readonly canonicalDigest: string;
  readonly layoutCount: number;
  readonly layerCount: number;
  readonly historyPastDepth: number;
  readonly historyFutureDepth: number;
  readonly historyBaselineClean: boolean;
  readonly activeLayoutId: string | null;
  readonly selectedLayerIds: readonly string[] | null;
  readonly viewport: RestoreViewportFact | null;
}

function malformed(
  scope: RestoreAuthorityScope,
  detail: string,
  code?: RestoreKernelIssueCode,
): AuthorityFinding {
  return { state: 'malformed', scope, detail, ...(code === undefined ? {} : { code }) };
}

function missing(
  scope: RestoreAuthorityScope,
  detail: string,
  code?: RestoreKernelIssueCode,
): AuthorityFinding {
  return { state: 'missing', scope, detail, ...(code === undefined ? {} : { code }) };
}

/**
 * Reads one accepted coherent document observation. Returns the exact
 * interpretable view or a structured unusable-authority finding. The source
 * observation is the pre-action authority and the restored observation is the
 * target authority; selection/viewport are validated only when present and are
 * never required-check authority.
 */
function classifyDocumentObservation(
  raw: unknown,
  scope: RestoreAuthorityScope,
  code: RestoreKernelIssueCode,
  label: string,
): DocumentObservationReading | AuthorityFinding {
  if (!isPlainRecord(raw)) {
    return missing(scope, `${label}: the accepted document observation is absent.`, code);
  }
  const documentId = stringOrNull(raw.documentId);
  if (documentId === null || documentId.length === 0) {
    return {
      state: 'wrong-target',
      scope,
      detail: `${label}: the document identity is absent.`,
      code,
    };
  }
  const route = stringOrNull(raw.route);
  if (route === null || route.length === 0) {
    return missing(scope, `${label}: the observed route is absent.`, code);
  }
  const documentEpoch = integerOrNull(raw.documentEpoch);
  if (documentEpoch === null || documentEpoch < 0) {
    return malformed(scope, `${label}: the document epoch is not a non-negative integer.`, code);
  }
  const observationId = stringOrNull(raw.observationId);
  if (observationId === null || observationId.length === 0) {
    return missing(scope, `${label}: no accepted observation identity exists.`, code);
  }
  const observationRevision = integerOrNull(raw.observationRevision);
  if (observationRevision === null || observationRevision < 0) {
    return malformed(
      scope,
      `${label}: the observation revision is not a non-negative integer.`,
      code,
    );
  }
  // The compiled capture currentness requires a live bridge generation.
  const bridgeGeneration = integerOrNull(raw.bridgeGeneration);
  if (bridgeGeneration === null || bridgeGeneration < 1) {
    return malformed(scope, `${label}: the bridge generation is not a positive integer.`, code);
  }
  const normalizedFingerprint = stringOrNull(raw.normalizedFingerprint);
  if (normalizedFingerprint === null || normalizedFingerprint.length === 0) {
    return missing(scope, `${label}: the normalized-meaning fingerprint is absent.`, code);
  }
  const canonicalDigest = stringOrNull(raw.canonicalDigest);
  if (canonicalDigest === null || canonicalDigest.length === 0) {
    return missing(scope, `${label}: the canonical normalized digest is absent.`, code);
  }
  const layoutCount = integerOrNull(raw.layoutCount);
  if (layoutCount === null || layoutCount < 0) {
    return malformed(scope, `${label}: the layout count is not a non-negative integer.`, code);
  }
  const layerCount = integerOrNull(raw.layerCount);
  if (layerCount === null || layerCount < 0) {
    return malformed(scope, `${label}: the layer count is not a non-negative integer.`, code);
  }
  const historyPastDepth = integerOrNull(raw.historyPastDepth);
  const historyFutureDepth = integerOrNull(raw.historyFutureDepth);
  if (
    historyPastDepth === null ||
    historyPastDepth < 0 ||
    historyFutureDepth === null ||
    historyFutureDepth < 0
  ) {
    return malformed(scope, `${label}: the history depth is not a non-negative integer.`, code);
  }
  const historyBaselineClean = booleanOrNull(raw.historyBaselineClean);
  if (historyBaselineClean === null) {
    return malformed(scope, `${label}: the history baselineClean fact is absent.`, code);
  }
  if (historyBaselineClean !== productBaselineClean(historyPastDepth, historyFutureDepth)) {
    return malformed(
      scope,
      `${label}: the history baselineClean is not the product-exact positional fact.`,
      code,
    );
  }
  const activeLayoutId = stringOrNull(raw.activeLayoutId);
  let selectedLayerIds: readonly string[] | null = null;
  if (raw.selectedLayerIds !== undefined && raw.selectedLayerIds !== null) {
    if (
      !Array.isArray(raw.selectedLayerIds) ||
      !raw.selectedLayerIds.every((entry) => typeof entry === 'string')
    ) {
      return malformed(scope, `${label}: the observed selection is not a list of layer ids.`, code);
    }
    selectedLayerIds = [...raw.selectedLayerIds];
  }
  let viewport: RestoreViewportFact | null = null;
  if (raw.viewport !== undefined && raw.viewport !== null) {
    if (!isPlainRecord(raw.viewport)) {
      return malformed(scope, `${label}: the observed viewport is not an object.`, code);
    }
    const widthCss = numberOrNull(raw.viewport.widthCss);
    const heightCss = numberOrNull(raw.viewport.heightCss);
    const devicePixelRatio = numberOrNull(raw.viewport.devicePixelRatio);
    if (
      widthCss === null ||
      widthCss <= 0 ||
      heightCss === null ||
      heightCss <= 0 ||
      devicePixelRatio === null ||
      devicePixelRatio <= 0
    ) {
      return malformed(
        scope,
        `${label}: the observed viewport is not a positive finite region.`,
        code,
      );
    }
    viewport = { widthCss, heightCss, devicePixelRatio };
  }
  return {
    documentId,
    documentEpoch,
    route,
    observationId,
    observationRevision,
    bridgeGeneration,
    normalizedFingerprint,
    canonicalDigest,
    layoutCount,
    layerCount,
    historyPastDepth,
    historyFutureDepth,
    historyBaselineClean,
    activeLayoutId,
    selectedLayerIds,
    viewport,
  };
}

function isDocumentReading(
  value: DocumentObservationReading | AuthorityFinding,
): value is DocumentObservationReading {
  return typeof (value as DocumentObservationReading).documentId === 'string';
}

/** Projects an interpretable reading onto the exact `actual` observation shape. */
function readingProjection(reading: DocumentObservationReading): RestoreKernelDocumentProjection {
  return {
    documentId: reading.documentId,
    documentEpoch: reading.documentEpoch,
    route: reading.route,
    observationId: reading.observationId,
    observationRevision: reading.observationRevision,
    bridgeGeneration: reading.bridgeGeneration,
    normalizedFingerprint: reading.normalizedFingerprint,
    canonicalDigest: reading.canonicalDigest,
    layoutCount: reading.layoutCount,
    layerCount: reading.layerCount,
    history: {
      pastDepth: reading.historyPastDepth,
      futureDepth: reading.historyFutureDepth,
      baselineClean: reading.historyBaselineClean,
    },
    activeLayoutId: reading.activeLayoutId,
    selectedLayerIds: reading.selectedLayerIds,
    viewport: reading.viewport,
  };
}

/**
 * Classifies the whole-document target/currentness authority: the source and
 * restored observations must be interpretable, must be genuinely distinct
 * current documents, and the delivered document-identity-distinct fact must
 * agree with the observations.
 */
function classifyTarget(facts: RestoreKernelFacts): {
  readonly finding: AuthorityFinding | null;
  readonly source: DocumentObservationReading | null;
  readonly restored: DocumentObservationReading | null;
} {
  const sourceReading = classifyDocumentObservation(
    facts.source,
    'pre-action',
    'RESTORE_KERNEL_SOURCE_OBSERVATION_UNINTERPRETABLE',
    'source',
  );
  const restoredReading = classifyDocumentObservation(
    facts.restored,
    'target',
    'RESTORE_KERNEL_RESTORED_OBSERVATION_UNINTERPRETABLE',
    'restored',
  );
  if (!isDocumentReading(sourceReading)) {
    return { finding: sourceReading, source: null, restored: null };
  }
  if (!isDocumentReading(restoredReading)) {
    return { finding: restoredReading, source: sourceReading, restored: null };
  }
  const transition = isPlainRecord(facts.transition) ? facts.transition : null;
  const distinctFact =
    transition === null ? null : booleanOrNull(transition.documentIdentityDistinct);
  if (sourceReading.documentId === restoredReading.documentId) {
    return {
      finding: {
        state: 'wrong-target',
        scope: 'target',
        detail:
          'The restored document identity equals the source document identity; the round trip did not resolve a new target document.',
      },
      source: sourceReading,
      restored: restoredReading,
    };
  }
  if (sourceReading.observationId === restoredReading.observationId) {
    return {
      finding: {
        state: 'ambiguous',
        scope: 'target',
        detail:
          'The restored observation identity is the source observation identity; the round-trip identity is not distinct.',
      },
      source: sourceReading,
      restored: restoredReading,
    };
  }
  if (distinctFact === false) {
    return {
      finding: {
        state: 'wrong-target',
        scope: 'target',
        detail:
          'The delivered document-identity-distinct fact is false for two observations that prove a distinct document.',
      },
      source: sourceReading,
      restored: restoredReading,
    };
  }
  if (distinctFact === null) {
    return {
      finding: malformed('target', 'The delivered document-identity-distinct fact is absent.'),
      source: sourceReading,
      restored: restoredReading,
    };
  }
  return { finding: null, source: sourceReading, restored: restoredReading };
}

/**
 * Classifies the delivered transition view shape. A malformed/absent shape is
 * unusable execution authority; the delivered boolean *values* remain a
 * trustworthy product comparison handled by the delivered check facts.
 */
function classifyTransitionShape(facts: RestoreKernelFacts): AuthorityFinding | null {
  const transition = facts.transition;
  if (!isPlainRecord(transition)) {
    return missing(
      'execution',
      'The accepted restore transition view is absent.',
      'RESTORE_KERNEL_TRANSITION_SHAPE_UNINTERPRETABLE',
    );
  }
  for (const field of TRANSITION_FACT_FIELDS) {
    const value = transition[field];
    if (
      field === 'createRequestCount' ||
      field === 'getRequestCount' ||
      field === 'harnessHydrateCalls' ||
      field === 'harnessStoreMutationCalls'
    ) {
      const count = integerOrNull(value);
      if (count === null || count < 0) {
        return malformed(
          'execution',
          `The transition fact "${field}" is not a request count.`,
          'RESTORE_KERNEL_TRANSITION_SHAPE_UNINTERPRETABLE',
        );
      }
      continue;
    }
    if (typeof value !== 'boolean') {
      return malformed(
        'execution',
        `The transition fact "${field}" is not interpretable.`,
        'RESTORE_KERNEL_TRANSITION_SHAPE_UNINTERPRETABLE',
      );
    }
  }
  // Harness hydration/store mutation is never a product result: a nonzero fact
  // means the harness interfered with the product document and no required
  // check may be trusted (`UNUSABLE`, never `PASS`/`FAIL`).
  if (transition.harnessHydrateCalls !== 0 || transition.harnessStoreMutationCalls !== 0) {
    return {
      state: 'malformed',
      scope: 'execution',
      detail:
        'The accepted restore chain reports harness hydrate/store-mutation calls; the product result is not trustworthy.',
    };
  }
  return null;
}

/** Classifies the delivered normalized-meaning view shape and fingerprint correlation. */
function classifyMeaningShape(
  facts: RestoreKernelFacts,
  source: DocumentObservationReading | null,
  restored: DocumentObservationReading | null,
): AuthorityFinding | null {
  const meaning = facts.meaning;
  if (!isPlainRecord(meaning)) {
    return missing(
      'execution',
      'The accepted restore meaning view is absent.',
      'RESTORE_KERNEL_MEANING_SHAPE_UNINTERPRETABLE',
    );
  }
  for (const field of [
    'normalizedStructurallyEqual',
    'normalizedFingerprintEqual',
    'inventoryPreserved',
    'persistenceLossDetected',
  ] as const) {
    if (typeof meaning[field] !== 'boolean') {
      return malformed(
        'execution',
        `The meaning fact "${field}" is not interpretable.`,
        'RESTORE_KERNEL_MEANING_SHAPE_UNINTERPRETABLE',
      );
    }
  }
  const sourceFingerprint = stringOrNull(meaning.sourceFingerprint);
  const restoredFingerprint = stringOrNull(meaning.restoredFingerprint);
  if (sourceFingerprint === null || restoredFingerprint === null) {
    return missing(
      'execution',
      'The accepted normalized-meaning fingerprints are absent.',
      'RESTORE_KERNEL_MEANING_SHAPE_UNINTERPRETABLE',
    );
  }
  if (source !== null && sourceFingerprint !== source.normalizedFingerprint) {
    return {
      state: 'ambiguous',
      scope: 'pre-action',
      detail:
        'The delivered source normalized-meaning fingerprint does not equal the coherent source observation fingerprint.',
    };
  }
  if (restored !== null && restoredFingerprint !== restored.normalizedFingerprint) {
    return {
      state: 'ambiguous',
      scope: 'target',
      detail:
        'The delivered restored normalized-meaning fingerprint does not equal the coherent restored observation fingerprint.',
    };
  }
  return null;
}

/** Classifies the delivered raw-semantics view shape. */
function classifyRawSemanticShape(facts: RestoreKernelFacts): AuthorityFinding | null {
  const raw = facts.rawSemantics;
  if (!isPlainRecord(raw)) {
    return missing(
      'execution',
      'The accepted restore raw-semantics view is absent.',
      'RESTORE_KERNEL_RAW_SEMANTIC_SHAPE_UNINTERPRETABLE',
    );
  }
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
    if (typeof raw[field] !== 'boolean') {
      return malformed(
        'execution',
        `The raw-semantics fact "${field}" is not interpretable.`,
        'RESTORE_KERNEL_RAW_SEMANTIC_SHAPE_UNINTERPRETABLE',
      );
    }
  }
  if (!Array.isArray(raw.words) || !raw.words.every((entry) => typeof entry === 'string')) {
    return malformed(
      'execution',
      'The raw-semantics words fact is not a list of strings.',
      'RESTORE_KERNEL_RAW_SEMANTIC_SHAPE_UNINTERPRETABLE',
    );
  }
  const generationSeed = raw.generationSeed;
  if (generationSeed !== null && numberOrNull(generationSeed) === null) {
    return malformed(
      'execution',
      'The raw-semantics generation seed is not interpretable.',
      'RESTORE_KERNEL_RAW_SEMANTIC_SHAPE_UNINTERPRETABLE',
    );
  }
  const layoutDigest = raw.layoutDigest;
  if (layoutDigest !== null && stringOrNull(layoutDigest) === null) {
    return malformed(
      'execution',
      'The raw-semantics layout digest is not interpretable.',
      'RESTORE_KERNEL_RAW_SEMANTIC_SHAPE_UNINTERPRETABLE',
    );
  }
  return null;
}

/** Classifies the accepted source-construction setup checkpoints. */
function classifySetup(setup: readonly unknown[]): AuthorityFinding | null {
  for (let index = 0; index < setup.length; index += 1) {
    const raw = setup[index];
    const label = `setup[${index}]`;
    if (!isPlainRecord(raw)) {
      return malformed('execution', `${label}: the setup checkpoint is not an object.`);
    }
    const role = stringOrNull(raw.role);
    if (role === null || role.length === 0) {
      return missing('execution', `${label}: the setup role is absent.`);
    }
    if (resolveRestoreSetupRecipe(role) === null) {
      return malformed(
        'execution',
        `${label}: the setup role "${role}" is not a declared source-construction recipe.`,
      );
    }
    const stepCount = integerOrNull(raw.stepCount);
    if (stepCount === null || stepCount < 0) {
      return malformed('execution', `${label}: the setup step count is not interpretable.`);
    }
    const past = integerOrNull(raw.historyPastDepth);
    const future = integerOrNull(raw.historyFutureDepth);
    if (past === null || past < 0 || future === null || future < 0) {
      return malformed('execution', `${label}: the setup history depth is not interpretable.`);
    }
    const clean = booleanOrNull(raw.historyBaselineClean);
    if (clean === null || clean !== productBaselineClean(past, future)) {
      return malformed(
        'execution',
        `${label}: the setup baselineClean is not the product-exact positional fact.`,
      );
    }
    const meaningFingerprint = stringOrNull(raw.meaningFingerprint);
    if (meaningFingerprint === null || meaningFingerprint.length === 0) {
      return missing('execution', `${label}: the setup meaning fingerprint is absent.`);
    }
  }
  return null;
}

/**
 * Compares the accepted readiness policy byte-for-byte with the compiled
 * readiness authority. A weaker accepted deadline/cadence/frame policy is
 * uninterpretable authority, never a product mismatch.
 */
function classifyReadiness(
  profile: ResolvedCorrectnessProfile,
  facts: RestoreKernelFacts,
): AuthorityFinding | null {
  const readiness = facts.readiness;
  const policy = isPlainRecord(readiness) ? readiness.policy : undefined;
  if (!isPlainRecord(policy)) {
    return {
      state: 'unavailable',
      scope: 'readiness',
      detail: 'The accepted restore facts carry no readiness policy projection.',
    };
  }
  const compiled = profile.readiness;
  const policyMatches =
    policy.profileId === compiled.profileId &&
    policy.deadlineCategory === compiled.deadlineCategory &&
    policy.deadlineMs === compiled.deadlineMs &&
    policy.signalWatchdogMs === compiled.signalWatchdogMs &&
    Array.isArray(policy.fallbackCadenceMs) &&
    policy.fallbackCadenceMs.length === compiled.fallbackCadenceMs.length &&
    policy.fallbackCadenceMs.every((entry, index) => entry === compiled.fallbackCadenceMs[index]) &&
    policy.stableFrames === compiled.stableFrames &&
    policy.quiescenceRequired === compiled.quiescenceRequired &&
    policy.stableFrameRequired === compiled.stableFrameRequired;
  if (!policyMatches) {
    return {
      state: 'malformed',
      scope: 'readiness',
      detail: `The accepted readiness policy (${String(policy.profileId)} ${String(policy.deadlineCategory)} ${String(policy.deadlineMs)}ms) does not equal the compiled readiness authority (${compiled.profileId} ${compiled.deadlineCategory} ${compiled.deadlineMs}ms).`,
    };
  }
  const observation = isPlainRecord(readiness) ? readiness.observation : undefined;
  const observationRecord = isPlainRecord(observation) ? observation : null;
  const outcome = observationRecord === null ? undefined : observationRecord.outcome;
  if (!isRestoreReadinessOutcome(outcome)) {
    return {
      state: 'missing',
      scope: 'readiness',
      detail: `The accepted readiness outcome "${String(outcome)}" is not in the closed vocabulary.`,
    };
  }
  if (outcome === 'stale') {
    return {
      state: 'stale',
      scope: 'readiness',
      detail: 'The accepted signal-first readiness gate reports a stale round-trip chain.',
    };
  }
  if (outcome === 'timeout') {
    return {
      state: 'stale',
      scope: 'readiness',
      detail: 'The accepted signal-first readiness gate timed out before the round trip settled.',
    };
  }
  if (outcome === 'invalidated') {
    return {
      state: 'unavailable',
      scope: 'readiness',
      detail: 'The accepted signal-first readiness gate was invalidated for this chain.',
    };
  }
  if (outcome === 'unavailable') {
    return {
      state: 'unavailable',
      scope: 'readiness',
      detail: 'No signal-first readiness authority was accepted for this chain.',
    };
  }
  const observedStableFrames =
    observationRecord === null ? null : numberOrNull(observationRecord.observedStableFrames);
  if (
    compiled.stableFrameRequired &&
    (observedStableFrames === null || observedStableFrames < compiled.stableFrames)
  ) {
    return {
      state: 'stale',
      scope: 'readiness',
      detail: `The accepted chain observed ${String(observedStableFrames)} stable frame(s), not the compiled required ${compiled.stableFrames}.`,
    };
  }
  return null;
}

/**
 * Recomputes the accepted whole-document restore authority from the delivered
 * facts. Every failure is a precise unusable authority state; only an exact,
 * mutually consistent, current round trip is `current`. No boolean fact may
 * rescue a non-current authority.
 */
function classifyAuthority(
  profile: ResolvedCorrectnessProfile,
  facts: RestoreKernelFacts,
): AuthorityClassification & {
  readonly source: DocumentObservationReading | null;
  readonly restored: DocumentObservationReading | null;
} {
  const findings: AuthorityFinding[] = [];
  if (facts.schemaVersion !== RESTORE_OBSERVATION_SCHEMA_VERSION) {
    findings.push(
      malformed(
        'execution',
        'The accepted restore observation schema is not supported.',
        'RESTORE_KERNEL_FACTS_SCHEMA_UNSUPPORTED',
      ),
    );
  }
  const target = classifyTarget(facts);
  if (target.finding !== null) findings.push(target.finding);
  const transition = classifyTransitionShape(facts);
  if (transition !== null) findings.push(transition);
  const meaning = classifyMeaningShape(facts, target.source, target.restored);
  if (meaning !== null) findings.push(meaning);
  const raw = classifyRawSemanticShape(facts);
  if (raw !== null) findings.push(raw);
  const setup = classifySetup(Array.isArray(facts.setup) ? facts.setup : []);
  if (setup !== null) findings.push(setup);
  const readiness = classifyReadiness(profile, facts);
  if (readiness !== null) findings.push(readiness);

  const first = findings[0];
  if (first === undefined) {
    return {
      state: 'current',
      scope: null,
      detail: 'current',
      code: null,
      findings,
      source: target.source,
      restored: target.restored,
    };
  }
  return {
    state: first.state,
    scope: first.scope,
    detail: first.detail,
    code: first.code ?? null,
    findings,
    source: target.source,
    restored: target.restored,
  };
}

interface EvidenceConsumption {
  readonly consumed: readonly string[];
  readonly authoritative: boolean;
  readonly authorityState: RestoreAuthorityState;
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
  facts: readonly RestoreEvidenceFact[],
  issues: RestoreKernelIssue[],
): EvidenceConsumption {
  const checkId = contract.checkId;
  const byId = new Map<string, RestoreEvidenceFact>();
  for (const fact of facts) {
    if (isPlainRecord(fact) && typeof fact.evidenceId === 'string') {
      byId.set(fact.evidenceId, fact as unknown as RestoreEvidenceFact);
    }
  }
  const globalDeclared = new Set(profile.requiredAuthoritativeEvidence);
  const consumed: string[] = [];
  let authorityState: RestoreAuthorityState = 'current';

  for (const requiredId of sortStrings(contract.requiredEvidence)) {
    if (!globalDeclared.has(requiredId)) {
      issues.push(
        issue(
          'RESTORE_KERNEL_EVIDENCE_UNDECLARED',
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
          'RESTORE_KERNEL_EVIDENCE_DIAGNOSTIC_ONLY',
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
          'RESTORE_KERNEL_EVIDENCE_UNDECLARED',
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

/**
 * A structured evaluator fact is well formed only when authority/currentness are
 * closed values and the source-correlation/mismatch facts are explicit booleans.
 * An incomplete or legacy-shaped record is never interpreted as a final status.
 */
function isWellFormedEvaluatorFact(value: unknown): value is RestoreEvaluatorFact {
  return (
    isPlainRecord(value) &&
    typeof value.checkId === 'string' &&
    isRestoreAuthorityState(value.authority) &&
    isRestoreFactCurrentness(value.currentness) &&
    typeof value.sourcesAgree === 'boolean' &&
    typeof value.mismatch === 'boolean'
  );
}

/**
 * Validates the accepted restore check facts against the compiled required-check
 * set: a declared check may have exactly one explicit structured fact, and an
 * undeclared or legacy-shaped check fact is rejected without being consumed.
 */
function validateCheckFacts(
  profile: ResolvedCorrectnessProfile,
  facts: RestoreKernelFacts,
  issues: RestoreKernelIssue[],
): void {
  const declaredIds = new Set(profile.requiredChecks.map((entry) => entry.checkId));
  const seenFactIds = new Set<string>();
  for (const fact of Array.isArray(facts.checks) ? facts.checks : []) {
    if (!isPlainRecord(fact) || typeof fact.checkId !== 'string') {
      issues.push(
        issue('RESTORE_KERNEL_FACT_STATUS_UNKNOWN', 'A restore check fact has no check id.'),
      );
      continue;
    }
    if (seenFactIds.has(fact.checkId)) {
      issues.push(
        issue(
          'RESTORE_KERNEL_FACT_CHECK_DUPLICATE',
          `Restore check fact "${fact.checkId}" appears more than once.`,
          fact.checkId,
        ),
      );
      continue;
    }
    seenFactIds.add(fact.checkId);
    if (!declaredIds.has(fact.checkId)) {
      issues.push(
        issue(
          'RESTORE_KERNEL_FACT_CHECK_UNKNOWN',
          `Restore check fact "${fact.checkId}" is not a declared required check.`,
          fact.checkId,
        ),
      );
    }
    if (!isWellFormedEvaluatorFact(fact)) {
      issues.push(
        issue(
          'RESTORE_KERNEL_FACT_AUTHORITY_UNKNOWN',
          `Restore check fact "${fact.checkId}" carries no explicit structured authority/currentness/source-correlation/mismatch facts.`,
          fact.checkId,
        ),
      );
    }
  }
}

// ── Defensive projections for `actual` ───────────────────────────────────────

function projectDocument(raw: unknown): RestoreKernelDocumentProjection {
  if (!isPlainRecord(raw)) {
    return {
      documentId: null,
      documentEpoch: null,
      route: null,
      observationId: null,
      observationRevision: null,
      bridgeGeneration: null,
      normalizedFingerprint: null,
      canonicalDigest: null,
      layoutCount: null,
      layerCount: null,
      history: { pastDepth: null, futureDepth: null, baselineClean: null },
      activeLayoutId: null,
      selectedLayerIds: null,
      viewport: null,
    };
  }
  const viewport = isPlainRecord(raw.viewport) ? raw.viewport : null;
  return {
    documentId: stringOrNull(raw.documentId),
    documentEpoch: integerOrNull(raw.documentEpoch),
    route: stringOrNull(raw.route),
    observationId: stringOrNull(raw.observationId),
    observationRevision: integerOrNull(raw.observationRevision),
    bridgeGeneration: integerOrNull(raw.bridgeGeneration),
    normalizedFingerprint: stringOrNull(raw.normalizedFingerprint),
    canonicalDigest: stringOrNull(raw.canonicalDigest),
    layoutCount: integerOrNull(raw.layoutCount),
    layerCount: integerOrNull(raw.layerCount),
    history: {
      pastDepth: integerOrNull(raw.historyPastDepth),
      futureDepth: integerOrNull(raw.historyFutureDepth),
      baselineClean: booleanOrNull(raw.historyBaselineClean),
    },
    activeLayoutId: stringOrNull(raw.activeLayoutId),
    selectedLayerIds: Array.isArray(raw.selectedLayerIds)
      ? raw.selectedLayerIds.filter((entry): entry is string => typeof entry === 'string')
      : null,
    viewport:
      viewport === null
        ? null
        : {
            widthCss: numberOrNull(viewport.widthCss),
            heightCss: numberOrNull(viewport.heightCss),
            devicePixelRatio: numberOrNull(viewport.devicePixelRatio),
          },
  };
}

function projectSetup(setup: readonly unknown[]): readonly RestoreKernelSetupProjection[] {
  return setup.map((raw) => {
    if (!isPlainRecord(raw)) {
      return {
        role: null,
        stepCount: null,
        historyPastDepth: null,
        historyFutureDepth: null,
        historyBaselineClean: null,
        baselineCleanProductExact: null,
        meaningFingerprint: null,
        declaredRecipe: null,
      };
    }
    const past = integerOrNull(raw.historyPastDepth);
    const future = integerOrNull(raw.historyFutureDepth);
    const clean = booleanOrNull(raw.historyBaselineClean);
    const role = stringOrNull(raw.role);
    return {
      role,
      stepCount: integerOrNull(raw.stepCount),
      historyPastDepth: past,
      historyFutureDepth: future,
      historyBaselineClean: clean,
      baselineCleanProductExact:
        clean === null || past === null || future === null
          ? null
          : clean === productBaselineClean(past, future),
      meaningFingerprint: stringOrNull(raw.meaningFingerprint),
      declaredRecipe: role === null ? null : resolveRestoreSetupRecipe(role) !== null,
    };
  });
}

function projectTransition(raw: unknown): Record<string, unknown> {
  const record = isPlainRecord(raw) ? raw : null;
  const booleanField = (field: string): boolean | null =>
    record === null ? null : booleanOrNull(record[field]);
  const countField = (field: string): number | null =>
    record === null ? null : integerOrNull(record[field]);
  return {
    saveDispatchedOnce: booleanField('saveDispatchedOnce'),
    createRequestCount: countField('createRequestCount'),
    createMethodMatches: booleanField('createMethodMatches'),
    createPathMatches: booleanField('createPathMatches'),
    createContentTypeMatches: booleanField('createContentTypeMatches'),
    createAfterEpoch: booleanField('createAfterEpoch'),
    getRequestCount: countField('getRequestCount'),
    getMethodMatches: booleanField('getMethodMatches'),
    getPathMatches: booleanField('getPathMatches'),
    redirectObserved: booleanField('redirectObserved'),
    navigateRouteMatches: booleanField('navigateRouteMatches'),
    documentIdentityDistinct: booleanField('documentIdentityDistinct'),
    restoredHistoryClean: booleanField('restoredHistoryClean'),
    harnessHydrateCalls: countField('harnessHydrateCalls'),
    harnessStoreMutationCalls: countField('harnessStoreMutationCalls'),
  };
}

function projectMeaning(raw: unknown): Record<string, unknown> {
  const record = isPlainRecord(raw) ? raw : null;
  const booleanField = (field: string): boolean | null =>
    record === null ? null : booleanOrNull(record[field]);
  return {
    normalizedStructurallyEqual: booleanField('normalizedStructurallyEqual'),
    normalizedFingerprintEqual: booleanField('normalizedFingerprintEqual'),
    sourceFingerprint: record === null ? null : stringOrNull(record.sourceFingerprint),
    restoredFingerprint: record === null ? null : stringOrNull(record.restoredFingerprint),
    inventoryPreserved: booleanField('inventoryPreserved'),
    persistenceLossDetected: booleanField('persistenceLossDetected'),
  };
}

function projectRawSemantics(raw: unknown): Record<string, unknown> {
  const record = isPlainRecord(raw) ? raw : null;
  const booleanField = (field: string): boolean | null =>
    record === null ? null : booleanOrNull(record[field]);
  return {
    crosswordPresent: booleanField('crosswordPresent'),
    generationSeed: record === null ? null : numberOrNull(record.generationSeed),
    words:
      record !== null && Array.isArray(record.words)
        ? record.words.filter((entry): entry is string => typeof entry === 'string')
        : [],
    layoutDigest: record === null ? null : stringOrNull(record.layoutDigest),
    restoredSeedMatches: booleanField('restoredSeedMatches'),
    restoredWordsMatch: booleanField('restoredWordsMatch'),
    restoredLayoutDigestMatches: booleanField('restoredLayoutDigestMatches'),
    rawConfigPresent: booleanField('rawConfigPresent'),
    rawServerMetadataPresent: booleanField('rawServerMetadataPresent'),
    normalizedHasNoIdKey: booleanField('normalizedHasNoIdKey'),
    normalizedHasNoConfigKey: booleanField('normalizedHasNoConfigKey'),
    normalizedHasNoServerMetadata: booleanField('normalizedHasNoServerMetadata'),
    volatileIdsDiffer: booleanField('volatileIdsDiffer'),
  };
}

/** Defensive projection of the additive named primitive Restore Oracle facts. */
function projectOracleFacts(facts: RestoreOracleFactsView | null): Record<string, unknown> | null {
  if (facts === null) return null;
  const transition = isPlainRecord(facts.transition) ? facts.transition : null;
  const meaning = isPlainRecord(facts.meaning) ? facts.meaning : null;
  const rawSemantics = isPlainRecord(facts.rawSemantics) ? facts.rawSemantics : null;
  return {
    authority: facts.authority,
    schemaVersion: numberOrNull(facts.schemaVersion),
    sourceAgreement: facts.sourceAgreement === true,
    transition: transition === null ? null : projectTransition(transition),
    meaning: meaning === null ? null : projectMeaning(meaning),
    rawSemantics: rawSemantics === null ? null : projectRawSemantics(rawSemantics),
    checks: Array.isArray(facts.checks)
      ? facts.checks.map((entry) => ({
          checkId: stringOrNull(entry.checkId),
          predicateMet: entry.predicateMet === true,
        }))
      : [],
  };
}

function expectedPayload(
  profile: ResolvedCorrectnessProfile,
  contract: ResolvedCheckContract,
): Record<string, unknown> {
  return {
    schema: contract.expectedSchema,
    evaluator: contract.evaluator,
    oracleProfileId: profile.oracle.oracleProfileId,
    checkId: contract.checkId,
    readinessProfileId: profile.readiness.profileId,
    timingCategory: profile.readiness.deadlineCategory,
    deadlineMs: profile.readiness.deadlineMs,
    captureProfileId: profile.capture.captureProfileId,
    currentnessIdentities: sortStrings(profile.readiness.currentnessIdentities),
    saveControlAccessibleName: RESTORE_SAVE_CONTROL.accessibleName,
    requiredTransitionFacts: [...TRANSITION_FACT_FIELDS],
    requiredMeaningFacts: [...MEANING_FACT_FIELDS],
    requiredRawSemanticFacts: [...RAW_SEMANTIC_FACT_FIELDS],
    requiredEvidence: sortStrings(contract.requiredEvidence),
    toleranceRefs: sortStrings(contract.toleranceRefs),
    visualRefs: sortStrings(contract.visualRefs),
    normalizationRef: contract.normalizationRef,
  };
}

function actualPayload(
  contract: ResolvedCheckContract,
  facts: RestoreKernelFacts,
  authorityState: RestoreAuthorityState,
  authorityScope: RestoreAuthorityScope | null,
  fact: RestoreEvaluatorFact | null,
  evidence: EvidenceConsumption,
  status: CheckResultStatus,
  normalizationApplicable: boolean,
  source: DocumentObservationReading | null,
  restored: DocumentObservationReading | null,
): Record<string, unknown> {
  const readiness = facts.readiness;
  const observation = isPlainRecord(readiness) ? readiness.observation : null;
  const meaning = isPlainRecord(facts.meaning) ? facts.meaning : null;
  return {
    schema: contract.actualSchema,
    status,
    authority: authorityState,
    authorityScope,
    readiness: {
      profileId:
        isPlainRecord(readiness) && isPlainRecord(readiness.policy)
          ? stringOrNull(readiness.policy.profileId)
          : null,
      deadlineCategory:
        isPlainRecord(readiness) && isPlainRecord(readiness.policy)
          ? stringOrNull(readiness.policy.deadlineCategory)
          : null,
      deadlineMs:
        isPlainRecord(readiness) && isPlainRecord(readiness.policy)
          ? numberOrNull(readiness.policy.deadlineMs)
          : null,
      outcome: isPlainRecord(observation) ? stringOrNull(observation.outcome) : null,
      wakeSource: isPlainRecord(observation) ? stringOrNull(observation.wakeSource) : null,
      fallbackPollCount: isPlainRecord(observation)
        ? integerOrNull(observation.fallbackPollCount)
        : null,
      watchdogWaits: isPlainRecord(observation) ? integerOrNull(observation.watchdogWaits) : null,
      observedStableFrames: isPlainRecord(observation)
        ? integerOrNull(observation.observedStableFrames)
        : null,
    },
    source: source === null ? projectDocument(facts.source) : readingProjection(source),
    restored: restored === null ? projectDocument(facts.restored) : readingProjection(restored),
    currentness: {
      document: [source?.documentId ?? null, restored?.documentId ?? null],
      epoch: [source?.documentEpoch ?? null, restored?.documentEpoch ?? null],
      bridgeGeneration: [source?.bridgeGeneration ?? null, restored?.bridgeGeneration ?? null],
      revision: [source?.observationRevision ?? null, restored?.observationRevision ?? null],
      distinctDocuments:
        source === null || restored === null ? null : source.documentId !== restored.documentId,
    },
    selection: {
      sourceActiveLayoutId: source?.activeLayoutId ?? null,
      sourceSelectedLayerIds: source?.selectedLayerIds ?? null,
      restoredActiveLayoutId: restored?.activeLayoutId ?? null,
      restoredSelectedLayerIds: restored?.selectedLayerIds ?? null,
    },
    setup: projectSetup(Array.isArray(facts.setup) ? facts.setup : []),
    transition: projectTransition(facts.transition),
    meaning: meaning === null ? projectMeaning(facts.meaning) : projectMeaning(meaning),
    rawSemantics: projectRawSemantics(facts.rawSemantics),
    normalization: {
      applicable: normalizationApplicable,
      sourceFingerprint: meaning === null ? null : stringOrNull(meaning.sourceFingerprint),
      restoredFingerprint: meaning === null ? null : stringOrNull(meaning.restoredFingerprint),
      reference: contract.normalizationRef,
    },
    oracle: {
      authority: fact === null ? null : fact.authority,
      currentness: fact === null ? null : fact.currentness,
      sourcesAgree: fact === null ? null : fact.sourcesAgree,
      mismatch: fact === null ? null : fact.mismatch,
    },
    oracleFacts: projectOracleFacts(facts.oracleFacts),
    diagnosticCodes: Array.isArray(facts.diagnostics)
      ? facts.diagnostics
          .map((entry) => (isPlainRecord(entry) ? stringOrNull(entry.code) : null))
          .filter((entry): entry is string => entry !== null)
      : [],
    consumedEvidence: sortStrings(evidence.consumed),
  };
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
 * A trustworthy product mismatch (a well-formed false transition, normalized
 * meaning, or raw-semantics fact) after valid, current, interpretable authority
 * is `FAIL`; a missing, stale, torn, ambiguous, malformed, wrong-target, or
 * otherwise non-authoritative pre-action/target/execution/readiness authority,
 * an absent or legacy-shaped accepted fact, a non-current evaluator authority,
 * or a non-authoritative required evidence role is `UNUSABLE`. No boolean check
 * result is translated into a status.
 */
function resolveStatus(
  authority: AuthorityClassification,
  fact: RestoreEvaluatorFact | null,
  evidence: EvidenceConsumption,
): { status: CheckResultStatus; authority: RestoreAuthorityState } {
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

function authorityIssueCode(scope: RestoreAuthorityScope | null): RestoreKernelIssueCode {
  switch (scope) {
    case 'target':
      return 'RESTORE_KERNEL_TARGET_AUTHORITY_UNUSABLE';
    case 'readiness':
      return 'RESTORE_KERNEL_READINESS_AUTHORITY_UNUSABLE';
    case 'pre-action':
      return 'RESTORE_KERNEL_PRE_ACTION_AUTHORITY_UNUSABLE';
    default:
      return 'RESTORE_KERNEL_EXECUTION_AUTHORITY_UNUSABLE';
  }
}

function runRestoreKernel(input: RestoreKernelInput): RestoreKernelResult {
  const { profile, route, actionCycle, facts } = input;
  const issues = validateProfile(profile, route, actionCycle);
  if (issues.length > 0) {
    return { kind: RESTORE_KERNEL_EVALUATOR, ok: false, checks: [], issues };
  }

  if (facts.evaluator !== RESTORE_KERNEL_EVALUATOR) {
    issues.push(
      issue(
        'RESTORE_KERNEL_FACTS_EVALUATOR_MISMATCH',
        `Restore facts declare evaluator "${String(facts.evaluator)}" instead of "${RESTORE_KERNEL_EVALUATOR}".`,
      ),
    );
  }

  validateCheckFacts(profile, facts, issues);
  const authority = classifyAuthority(profile, facts);
  if (authority.state !== 'current' && authority.scope === 'readiness') {
    if (authority.state === 'malformed') {
      issues.push(issue('RESTORE_KERNEL_READINESS_POLICY_MISMATCH', authority.detail));
    }
  }
  if (authority.state !== 'current') {
    issues.push(issue(authorityIssueCode(authority.scope), authority.detail));
    if (authority.code !== null) {
      issues.push(issue(authority.code, authority.detail));
    }
  }

  const factById = new Map<string, RestoreEvaluatorFact>();
  for (const fact of Array.isArray(facts.checks) ? facts.checks : []) {
    if (
      isPlainRecord(fact) &&
      typeof fact.checkId === 'string' &&
      isWellFormedEvaluatorFact(fact) &&
      !factById.has(fact.checkId)
    ) {
      factById.set(fact.checkId, fact as unknown as RestoreEvaluatorFact);
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
          'RESTORE_KERNEL_FACT_CHECK_MISSING',
          `No accepted restore evaluator fact exists for declared check "${contract.checkId}".`,
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
        expectedPayload(profile, contract),
        actualPayload(
          contract,
          facts,
          resolved.authority,
          authority.state === 'current' ? null : authority.scope,
          fact,
          evidence,
          resolved.status,
          isPlainRecord(profile.normalization) && profile.normalization.applicable === true,
          authority.source,
          authority.restored,
        ),
        evidence.consumed,
      ),
    );
  }

  return { kind: RESTORE_KERNEL_EVALUATOR, ok: true, checks, issues };
}

/**
 * The frontend serialize/restore final kernel. It evaluates the profile's
 * declared restore checks from the accepted Oracle, source/restored document,
 * setup, readiness, currentness, and evidence facts.
 */
export function evaluateRestoreChecks(input: RestoreKernelInput): RestoreKernelResult {
  return runRestoreKernel(input);
}

/** Runtimes dispatch to exactly one frontend serialize/restore kernel kind. */
export function restoreKernelKindForEvaluator(
  evaluatorKind: string | null | undefined,
): RestoreKernelKind | null {
  return evaluatorKind === RESTORE_KERNEL_EVALUATOR ? RESTORE_KERNEL_EVALUATOR : null;
}
