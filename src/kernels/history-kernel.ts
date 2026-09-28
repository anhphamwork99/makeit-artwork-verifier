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
  HISTORY_ACTION_STEPS,
  HISTORY_CONTROLS,
  HISTORY_CONTROL_BUTTON_TYPE,
  HISTORY_CONTROL_NATIVE_TAG,
  HISTORY_SETUP_CHECKPOINTS,
  historyTupleWithCleanEquals,
  productBaselineClean,
} from '../contracts/history-observation';
import { isPlainRecord } from '../contracts/result-agreement';
import {
  CHECK_RESULT_CONTRACT_SCHEMA_VERSION,
  RESOLVED_CORRECTNESS_PROFILE_SCHEMA_VERSION,
} from '../contracts/schema-versions';

/**
 * P7-B B1-F1 inactive final compiled-profile kernel for cross-subject History
 * (ADR 0028 §3 B1-F; the History half).
 *
 * The cross-subject History capability is proven by the accepted
 * `history-cross-subject` Oracle (WP5 Slice 5-F; ADR 0019 R3/R4/R10/R11; ADR
 * 0020 A1–A8). One whole-document Action Cycle chain constructs the accepted
 * mixed precondition (`H0` sealed host → `H1` created Text → `H2` created Image
 * placeholder → `H3` created Crossword) through seller-visible controls, then
 * performs the exact six native toolbar transitions (Undo ×3, Redo ×3) and
 * resolves the two declared checks (`history.depth`, `history.meaning`).
 *
 * This kernel is the *inactive final* consumer of those facts. It receives
 * exactly the compiled `ResolvedCorrectnessProfile`, the route the runtime
 * resolved, the Action Cycle correctness identity that observed the action
 * chain, and the accepted WP5 history facts:
 *
 *  1. the accepted Oracle execution facts — the exact `H0`…`H3` cross-subject
 *     setup checkpoints, the six ordered Undo/Redo transition observations, the
 *     retained whole-document Layout identity, and the final tuple — validated
 *     here against the accepted history observation contract so a missing,
 *     stale, torn, ambiguous, malformed, or wrong-target identity is unusable
 *     even when a boolean fact claims otherwise;
 *  2. the accepted readiness policy and observation the whole-document Action
 *     Cycle chain obeyed (one non-extending `INTERACTIVE_HISTORY_V1` deadline);
 *  3. the delivered structured per-check evaluator facts (authority,
 *     currentness, chain agreement, and product mismatch), the accepted
 *     Oracle's raw named primitive fact projection, and the delivered
 *     diagnostics; and
 *  4. the observed evidence roles for the whole-document Action Cycle chain.
 *
 * It returns one complete, field-rich `CorrectnessCheckResult` per declared
 * required check — or, when the compiled profile itself is not trustworthy, no
 * fabricated checks at all.
 *
 * Every correctness input is read from the compiled profile. This module owns no
 * required-check list, no check id, no tolerance/visual/normalization literal,
 * no deadline policy, no fallback id, and no Subject-name/family/scenario
 * branch; it never reloads an authoring catalogue. The accepted cross-subject
 * History meaning is preserved exactly:
 *
 *  - a trustworthy product mismatch (wrong post-transition tuple, wrong restored
 *    normalized meaning, or a final tuple that is not the exact `H3`) after
 *    valid, current, interpretable authority is `FAIL`;
 *  - missing / stale / torn / ambiguous / malformed / wrong-target pre-action,
 *    target, execution, or readiness authority, a non-current evaluator
 *    authority, or a legacy-shaped evaluator fact is `UNUSABLE`;
 *  - a diagnostic-only item can never rescue a required check.
 *
 * The pre-action baseline is the authoritative head of the chain: the exact
 * `H3`/`H0`…`H3` construction and every transition's `historyBefore` must
 * correlate byte-exactly with the previous accepted `historyAfter` (ADR 0027
 * §3.2 B-R2's fail-closed pre-action authority, applied to the cross-subject
 * History chain). A pre-action identity that cannot be correlated is never
 * dispatched into a passing check.
 *
 * The kernel is deliberately inactive. Nothing here is imported by the active
 * executor, Oracle, classifier, writer, or CLI, and no module under `src/runtime`
 * or `src/oracles` is imported in return: the fact contract below is
 * structurally satisfied by the accepted `HistoryEvidenceFacts` projection and
 * the accepted drive readiness facts, so the atomic B2 cutover can pass the
 * delivered facts in without this module depending on active machinery.
 */

/** The single delivered cross-subject History evaluator family this kernel owns. */
export const HISTORY_KERNEL_KINDS = ['history-cross-subject'] as const;
export type HistoryKernelKind = (typeof HISTORY_KERNEL_KINDS)[number];

/** The compiled Oracle discriminant the History route resolves. */
export const HISTORY_KERNEL_EVALUATOR = 'history-cross-subject';

/**
 * The closed per-check evaluator discriminants the `history-cross-subject`
 * Oracle declares. A compiled profile that declares a different check evaluator
 * cannot be interpreted by this kernel.
 */
export const HISTORY_KERNEL_CHECK_EVALUATORS = ['history-cross-subject'] as const;

/**
 * Closed evidence-availability vocabulary. Only `authoritative` evidence is
 * current and interpretable; every other state makes a required check
 * `UNUSABLE`. `diagnostic-only` is the single role that must never satisfy a
 * required check.
 */
export const HISTORY_EVIDENCE_AVAILABILITY = [
  'authoritative',
  'ambiguous',
  'diagnostic-only',
  'malformed',
  'missing',
  'stale',
  'torn',
] as const;
export type HistoryEvidenceAvailability = (typeof HISTORY_EVIDENCE_AVAILABILITY)[number];

export function isHistoryEvidenceAvailability(
  value: unknown,
): value is HistoryEvidenceAvailability {
  return (
    typeof value === 'string' &&
    (HISTORY_EVIDENCE_AVAILABILITY as readonly string[]).includes(value)
  );
}

/** One accepted evidence fact the whole-document Action Cycle chain observed. */
export interface HistoryEvidenceFact {
  readonly evidenceId: string;
  readonly availability: HistoryEvidenceAvailability;
}

/** Closed authority state recorded in every `actual` interpretation. */
export const HISTORY_AUTHORITY_STATES = [
  'ambiguous',
  'current',
  'malformed',
  'missing',
  'stale',
  'torn',
  'unavailable',
  'wrong-target',
] as const;
export type HistoryAuthorityState = (typeof HISTORY_AUTHORITY_STATES)[number];

/**
 * Closed structured currentness vocabulary for one accepted evaluator fact
 * (ADR 0029 §4 B2-B). Currentness is an explicit structured fact recorded per
 * check; it is never a final result status.
 */
export const HISTORY_FACT_CURRENTNESS = ['current', 'stale', 'torn', 'unavailable'] as const;
export type HistoryFactCurrentness = (typeof HISTORY_FACT_CURRENTNESS)[number];

/** Projects a structured authority state onto the closed currentness domain. */
export function historyCurrentnessForAuthority(
  authority: HistoryAuthorityState,
): HistoryFactCurrentness {
  if (authority === 'current') return 'current';
  if (authority === 'stale') return 'stale';
  if (authority === 'torn') return 'torn';
  return 'unavailable';
}

function isHistoryAuthorityState(value: unknown): value is HistoryAuthorityState {
  return (
    typeof value === 'string' && (HISTORY_AUTHORITY_STATES as readonly string[]).includes(value)
  );
}

function isHistoryFactCurrentness(value: unknown): value is HistoryFactCurrentness {
  return (
    typeof value === 'string' && (HISTORY_FACT_CURRENTNESS as readonly string[]).includes(value)
  );
}

/**
 * One accepted per-check History evaluator fact in explicit structured form
 * (ADR 0029 §4 B2-B). The legacy boolean `passed` is replaced by structured
 * authority, currentness, chain-agreement, and product-mismatch facts so the
 * kernel maps them to a status from explicit structure instead of translating
 * a boolean check result. The facts are supplied by the inactive B2-B5
 * live-fact adapter from the delivered History Oracle observations; this module
 * owns no predicate policy of its own.
 */
export interface HistoryEvaluatorFact {
  readonly checkId: string;
  /** Structured authority state of the accepted evaluator fact. */
  readonly authority: HistoryAuthorityState;
  /** Structured currentness of the accepted evaluator fact. */
  readonly currentness: HistoryFactCurrentness;
  /** Whether the independent raw-chain/source observations agreed. */
  readonly sourcesAgree: boolean;
  /** A trustworthy product mismatch under a current authority. */
  readonly mismatch: boolean;
}

/** One raw primitive per-check predicate of the accepted History Oracle. */
export interface HistoryPrimitiveCheckFactView {
  readonly checkId: string;
  readonly predicateMet: boolean;
}

/** Raw accepted `H0`…`H3` setup checkpoint primitive. */
export interface HistoryPrimitiveSetupFactView {
  readonly checkpointId: string;
  readonly role: string;
  readonly meaning: string;
  readonly pastDepth: number;
  readonly futureDepth: number;
  readonly baselineClean: boolean;
  readonly meaningFingerprint: string;
}

/** Raw accepted ordered transition primitive with its currentness/epoch facts. */
export interface HistoryPrimitiveTransitionFactView {
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
 * The additive named primitive History Oracle facts the inactive B2-B5 adapter
 * consumed. Every field is a raw primitive observation (a structured
 * authority, the retained whole-document target, the raw `H0`…`H3` setup
 * checkpoints, the raw ordered six-transition chain with native control,
 * revision, epoch, idle, and torn facts, the final tuple, the raw pre-action
 * chain-correlation primitive, and one predicate per selected check); no field
 * is a legacy composite boolean check result or an aggregate harness flag.
 */
export interface HistoryOracleFactsView {
  readonly authority: 'current' | 'malformed';
  /** The raw pre-action chain/source-correlation agreement primitive. */
  readonly chainAgreement: boolean;
  readonly retainedLayoutId: string | null;
  readonly setup: readonly HistoryPrimitiveSetupFactView[] | null;
  readonly transitions: readonly HistoryPrimitiveTransitionFactView[] | null;
  readonly finalHistory: HistoryKernelTupleView | null;
  readonly checks: readonly HistoryPrimitiveCheckFactView[];
}

/**
 * The authority scope the kernel refuses. It distinguishes the pre-action /
 * target arms (which must correlate exactly) from the structural execution arm
 * and the readiness gate, so a precise structured issue names the failing
 * authority without inventing a check.
 */
export const HISTORY_AUTHORITY_SCOPES = ['execution', 'pre-action', 'readiness', 'target'] as const;
export type HistoryAuthorityScope = (typeof HISTORY_AUTHORITY_SCOPES)[number];

/** Closed signal-first readiness outcomes for one Undo/Redo transition chain. */
export const HISTORY_READINESS_OUTCOMES = [
  'invalidated',
  'signal',
  'stale',
  'timeout',
  'unavailable',
] as const;
export type HistoryReadinessOutcome = (typeof HISTORY_READINESS_OUTCOMES)[number];

export function isHistoryReadinessOutcome(value: unknown): value is HistoryReadinessOutcome {
  return (
    typeof value === 'string' && (HISTORY_READINESS_OUTCOMES as readonly string[]).includes(value)
  );
}

/** The compiled readiness policy the whole-document chain applied. */
export interface HistoryReadinessPolicyFact {
  readonly profileId: string;
  readonly deadlineCategory: string;
  readonly deadlineMs: number;
  readonly signalWatchdogMs: number;
  readonly fallbackCadenceMs: readonly number[];
  readonly stableFrames: number;
  readonly quiescenceRequired: boolean;
  readonly stableFrameRequired: boolean;
}

/** The observed signal-first readiness execution of the transition chain. */
export interface HistoryReadinessObservationFact {
  readonly outcome: HistoryReadinessOutcome;
  readonly wakeSource: string | null;
  readonly fallbackPollCount: number;
  readonly watchdogWaits: number;
  readonly observedStableFrames: number | null;
  readonly detail: string | null;
}

/** Accepted readiness facts: the compiled policy plus the observed execution. */
export interface HistoryReadinessFact {
  readonly policy: HistoryReadinessPolicyFact;
  readonly observation: HistoryReadinessObservationFact;
}

/** The route a kernel is asked to evaluate. Passed in; never selected internally. */
export interface HistoryKernelRoute {
  readonly subjectId: string;
  readonly capability: Capability;
  readonly variant: string | null;
}

/** Defensive projection of one raw accepted setup checkpoint, for `actual`. */
export interface HistoryKernelSetupProjection {
  readonly checkpointId: string | null;
  readonly role: string | null;
  readonly meaning: string | null;
  readonly pastDepth: number | null;
  readonly futureDepth: number | null;
  readonly baselineClean: boolean | null;
  readonly baselineCleanProductExact: boolean | null;
  readonly meaningFingerprint: string | null;
}

/** Defensive projection of one raw accepted transition, for `actual`. */
export interface HistoryKernelTransitionProjection {
  readonly stepIndex: number | null;
  readonly stepId: string | null;
  readonly order: number;
  readonly control: string | null;
  readonly controlAccessibleName: string | null;
  readonly controlTitle: string | null;
  readonly controlNativeTag: string | null;
  readonly controlButtonType: string | null;
  readonly controlVisible: boolean | null;
  readonly controlEnabledBeforeDispatch: boolean | null;
  readonly dispatchCount: number | null;
  readonly actionEpochId: string | null;
  readonly observationId: string | null;
  readonly preActionRevision: number | null;
  readonly postActionRevision: number | null;
  readonly revisionAdvanced: boolean | null;
  readonly idle: {
    readonly stableFrames: number | null;
    readonly waitedMs: number | null;
    readonly observationRevision: number | null;
  } | null;
  readonly idleCurrent: boolean | null;
  readonly historyBefore: HistoryKernelTupleView | null;
  readonly historyAfter: HistoryKernelTupleView | null;
  readonly expectedHistory: HistoryKernelTupleView | null;
  readonly historyTupleExact: boolean | null;
  readonly expectedMeaning: string | null;
  readonly meaningFingerprint: string | null;
  readonly expectedMeaningFingerprint: string | null;
  readonly meaningFingerprintEqual: boolean | null;
  readonly meaningStructurallyEqual: boolean | null;
  readonly transitionObserved: boolean | null;
  readonly tornRecaptureCount: number | null;
}

export interface HistoryKernelTupleView {
  readonly pastDepth: number;
  readonly futureDepth: number;
  readonly baselineClean: boolean;
}

/**
 * Accepted cross-subject History facts: the exact `H0`…`H3` setup checkpoints,
 * the six ordered transitions, the retained whole-document Layout identity, the
 * final tuple, the readiness policy/observation, the delivered structured
 * per-check evaluator facts, the accepted Oracle's raw named primitive fact
 * projection, the delivered diagnostics, and the observed evidence roles.
 * `setup`, `actions`, and `finalHistory` are typed `unknown` so the kernel
 * validates them through the accepted observation contract rather than trusting
 * a caller-supplied shape.
 *
 * The legacy aggregate `harnessInvalid` flag and the legacy per-check boolean
 * `passed` are deliberately absent (ADR 0029 §4 B2-B): `checks` carries the
 * explicit structured authority/currentness/chain-agreement/mismatch facts for
 * every declared check, and `oracleFacts` carries the accepted Oracle's raw
 * named primitive fact projection. No boolean check result is translated into
 * a final status.
 */
export interface HistoryKernelFacts {
  readonly evaluator: typeof HISTORY_KERNEL_EVALUATOR;
  readonly retainedLayoutId: string | null;
  readonly setup: readonly unknown[];
  readonly actions: readonly unknown[];
  readonly finalHistory: unknown;
  readonly readiness: HistoryReadinessFact;
  readonly checks: readonly HistoryEvaluatorFact[];
  /** The raw named primitive History Oracle facts, or `null` when none ran. */
  readonly oracleFacts: HistoryOracleFactsView | null;
  readonly diagnostics: readonly { readonly code: string; readonly detail: string }[];
  readonly evidence: readonly HistoryEvidenceFact[];
}

/** Closed kernel issue vocabulary; deliberately local to the inactive kernel. */
export const HISTORY_KERNEL_ISSUE_CODES = [
  'HISTORY_KERNEL_PROFILE_NOT_OBJECT',
  'HISTORY_KERNEL_PROFILE_SCHEMA_UNSUPPORTED',
  'HISTORY_KERNEL_PROFILE_FINGERPRINT_MISSING',
  'HISTORY_KERNEL_PROFILE_FINGERPRINT_INVALID',
  'HISTORY_KERNEL_PROFILE_FINGERPRINT_MISMATCH',
  'HISTORY_KERNEL_COMPONENT_FINGERPRINT_INVALID',
  'HISTORY_KERNEL_ROUTE_MISMATCH',
  'HISTORY_KERNEL_ORACLE_EVALUATOR_UNSUPPORTED',
  'HISTORY_KERNEL_CHECK_EVALUATOR_UNSUPPORTED',
  'HISTORY_KERNEL_REQUIRED_CHECK_MISSING',
  'HISTORY_KERNEL_REQUIRED_CHECK_DUPLICATE',
  'HISTORY_KERNEL_EMPTY_REQUIRED_CHECKS',
  'HISTORY_KERNEL_ACTION_CYCLE_MISMATCH',
  'HISTORY_KERNEL_READINESS_MISMATCH',
  'HISTORY_KERNEL_FACTS_EVALUATOR_MISMATCH',
  'HISTORY_KERNEL_FACT_CHECK_MISSING',
  'HISTORY_KERNEL_FACT_CHECK_UNKNOWN',
  'HISTORY_KERNEL_FACT_CHECK_DUPLICATE',
  'HISTORY_KERNEL_FACT_STATUS_UNKNOWN',
  'HISTORY_KERNEL_FACT_AUTHORITY_UNKNOWN',
  'HISTORY_KERNEL_TARGET_AUTHORITY_UNUSABLE',
  'HISTORY_KERNEL_READINESS_AUTHORITY_UNUSABLE',
  'HISTORY_KERNEL_READINESS_POLICY_MISMATCH',
  'HISTORY_KERNEL_PRE_ACTION_AUTHORITY_UNUSABLE',
  'HISTORY_KERNEL_EXECUTION_AUTHORITY_UNUSABLE',
  'HISTORY_KERNEL_EVIDENCE_UNDECLARED',
  'HISTORY_KERNEL_EVIDENCE_DIAGNOSTIC_ONLY',
] as const;
export type HistoryKernelIssueCode = (typeof HISTORY_KERNEL_ISSUE_CODES)[number];

export interface HistoryKernelIssue {
  readonly code: HistoryKernelIssueCode;
  readonly detail: string;
  readonly checkId: string | null;
}

export interface HistoryKernelResult {
  readonly kind: HistoryKernelKind;
  /**
   * `true` when the compiled profile was trustworthy and a complete check
   * result was produced for every declared check (possibly all `UNUSABLE`).
   * `false` when the profile itself failed validation; `checks` is then empty
   * because no trustworthy check may be fabricated from an invalid profile.
   */
  readonly ok: boolean;
  readonly checks: readonly CorrectnessCheckResult[];
  readonly issues: readonly HistoryKernelIssue[];
}

export interface HistoryKernelInput {
  readonly profile: ResolvedCorrectnessProfile;
  readonly route: HistoryKernelRoute;
  readonly actionCycle: ActionCycleCorrectnessIdentity;
  readonly facts: HistoryKernelFacts;
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

const ACTION_COUNT = HISTORY_ACTION_STEPS.length;
const SETUP_COUNT = HISTORY_SETUP_CHECKPOINTS.length;

/** The exact `H3` pre-action baseline the six transitions start from. */
const PRE_ACTION_BASELINE: HistoryKernelTupleView = Object.freeze({
  pastDepth: 3,
  futureDepth: 0,
  baselineClean: false,
});

function issue(
  code: HistoryKernelIssueCode,
  detail: string,
  checkId: string | null = null,
): HistoryKernelIssue {
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
 * Validates that the compiled profile is exactly the immutable cross-subject
 * History profile for the requested route and that the Action Cycle observed the
 * same profile. Every failure is fail-closed and reported as a structured issue;
 * the fingerprint is independently recomputed from the profile content so a
 * mutated compiled field is detected rather than trusted.
 */
function validateProfile(
  profile: ResolvedCorrectnessProfile,
  route: HistoryKernelRoute,
  actionCycle: ActionCycleCorrectnessIdentity,
): HistoryKernelIssue[] {
  const issues: HistoryKernelIssue[] = [];
  if (!isPlainRecord(profile)) {
    issues.push(
      issue('HISTORY_KERNEL_PROFILE_NOT_OBJECT', 'The compiled profile is not a plain object.'),
    );
    return issues;
  }
  if (profile.schemaVersion !== RESOLVED_CORRECTNESS_PROFILE_SCHEMA_VERSION) {
    issues.push(
      issue(
        'HISTORY_KERNEL_PROFILE_SCHEMA_UNSUPPORTED',
        `Resolved-profile schema ${String(profile.schemaVersion)} is not supported.`,
      ),
    );
  }

  const storedFingerprint = profile.resolvedFingerprint;
  if (storedFingerprint === undefined || storedFingerprint === null) {
    issues.push(
      issue(
        'HISTORY_KERNEL_PROFILE_FINGERPRINT_MISSING',
        'The compiled profile carries no resolved fingerprint.',
      ),
    );
  } else if (!isFullCanonicalFingerprint(storedFingerprint)) {
    issues.push(
      issue(
        'HISTORY_KERNEL_PROFILE_FINGERPRINT_INVALID',
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
          'HISTORY_KERNEL_PROFILE_FINGERPRINT_MISMATCH',
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
        'HISTORY_KERNEL_COMPONENT_FINGERPRINT_INVALID',
        'The compiled profile carries no component fingerprints.',
      ),
    );
  } else {
    for (const field of COMPONENT_FINGERPRINT_FIELDS) {
      if (!isFullCanonicalFingerprint(componentFingerprints[field])) {
        issues.push(
          issue(
            'HISTORY_KERNEL_COMPONENT_FINGERPRINT_INVALID',
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
        'HISTORY_KERNEL_ROUTE_MISMATCH',
        `Compiled profile route ${profile.subjectId}×${String(profile.capability)}@${profile.variant ?? '∅'} does not equal the requested route ${route.subjectId}×${String(route.capability)}@${route.variant ?? '∅'}.`,
      ),
    );
  }

  const oracle: unknown = profile.oracle;
  if (!isPlainRecord(oracle) || oracle.evaluatorKind !== HISTORY_KERNEL_EVALUATOR) {
    const found = isPlainRecord(oracle) ? String(oracle.evaluatorKind) : 'undefined';
    issues.push(
      issue(
        'HISTORY_KERNEL_ORACLE_EVALUATOR_UNSUPPORTED',
        `Compiled Oracle evaluator "${found}" is not supported by this History kernel (expected "${HISTORY_KERNEL_EVALUATOR}").`,
      ),
    );
  }

  const requiredChecks = Array.isArray(profile.requiredChecks) ? profile.requiredChecks : [];
  if (requiredChecks.length === 0) {
    issues.push(
      issue(
        'HISTORY_KERNEL_EMPTY_REQUIRED_CHECKS',
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
          'HISTORY_KERNEL_REQUIRED_CHECK_MISSING',
          'A declared required check has no check id.',
        ),
      );
      continue;
    }
    if (seen.has(checkId)) {
      issues.push(
        issue(
          'HISTORY_KERNEL_REQUIRED_CHECK_DUPLICATE',
          `Declared required check "${checkId}" appears more than once.`,
          checkId,
        ),
      );
      continue;
    }
    seen.add(checkId);
    if (
      typeof check.evaluator !== 'string' ||
      !(HISTORY_KERNEL_CHECK_EVALUATORS as readonly string[]).includes(check.evaluator)
    ) {
      issues.push(
        issue(
          'HISTORY_KERNEL_CHECK_EVALUATOR_UNSUPPORTED',
          `Required check "${checkId}" declares evaluator "${String(check.evaluator)}" which this History kernel does not support.`,
          checkId,
        ),
      );
    }
  }

  if (actionCycle.resolvedProfileFingerprint !== storedFingerprint) {
    issues.push(
      issue(
        'HISTORY_KERNEL_ACTION_CYCLE_MISMATCH',
        'The Action Cycle resolved-profile fingerprint does not equal the compiled profile fingerprint.',
      ),
    );
  }
  if (actionCycle.readinessFingerprint !== profile.componentFingerprints?.readiness) {
    issues.push(
      issue(
        'HISTORY_KERNEL_READINESS_MISMATCH',
        'The Action Cycle readiness fingerprint does not equal the compiled readiness component.',
      ),
    );
  }
  return issues;
}

// ── Accepted execution/target/readiness authority ────────────────────────────

interface AuthorityFinding {
  readonly state: HistoryAuthorityState;
  readonly scope: HistoryAuthorityScope;
  readonly detail: string;
}

interface AuthorityClassification {
  readonly state: HistoryAuthorityState;
  readonly scope: HistoryAuthorityScope | null;
  readonly detail: string;
  readonly findings: readonly AuthorityFinding[];
}

/** Reads one closed history tuple, or `null` when it is not interpretable. */
export function readHistoryKernelTuple(value: unknown): HistoryKernelTupleView | null {
  if (!isPlainRecord(value)) return null;
  const pastDepth = value.pastDepth;
  const futureDepth = value.futureDepth;
  const baselineClean = value.baselineClean;
  if (typeof pastDepth !== 'number' || !Number.isInteger(pastDepth) || pastDepth < 0) return null;
  if (typeof futureDepth !== 'number' || !Number.isInteger(futureDepth) || futureDepth < 0) {
    return null;
  }
  if (typeof baselineClean !== 'boolean') return null;
  return { pastDepth, futureDepth, baselineClean };
}

function malformed(label: string, detail: string): AuthorityFinding {
  return { state: 'malformed', scope: 'execution', detail: `${label}: ${detail}` };
}

/**
 * Classifies the retained whole-document Layout identity. The History chain is
 * whole-document: without an exact retained Layout identity the transitions
 * have no target authority and every check is unusable.
 */
function classifyTarget(facts: HistoryKernelFacts): AuthorityFinding | null {
  const retained = facts.retainedLayoutId;
  if (typeof retained !== 'string') {
    return {
      state: 'missing',
      scope: 'target',
      detail: 'The accepted History facts carry no retained Layout identity.',
    };
  }
  if (retained.length === 0) {
    return {
      state: 'wrong-target',
      scope: 'target',
      detail: 'The accepted History retained Layout identity is empty.',
    };
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
  facts: HistoryKernelFacts,
): AuthorityFinding | null {
  const readiness = facts.readiness;
  const policy = isPlainRecord(readiness) ? readiness.policy : undefined;
  if (!isPlainRecord(policy)) {
    return {
      state: 'unavailable',
      scope: 'readiness',
      detail: 'The accepted History facts carry no readiness policy projection.',
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
  if (!isHistoryReadinessOutcome(outcome)) {
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
      detail: 'The accepted signal-first readiness gate reports a stale transition chain.',
    };
  }
  if (outcome === 'timeout') {
    return {
      state: 'stale',
      scope: 'readiness',
      detail:
        'The accepted signal-first readiness gate timed out before the transition chain settled.',
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

/** Classifies the exact `H0`…`H3` cross-subject setup checkpoint contract. */
function classifySetup(setup: readonly unknown[]): AuthorityFinding | null {
  if (setup.length === 0) {
    return {
      state: 'missing',
      scope: 'execution',
      detail: 'The accepted History facts carry no setup checkpoint observations.',
    };
  }
  if (setup.length !== SETUP_COUNT) {
    return {
      state: setup.length > SETUP_COUNT ? 'ambiguous' : 'missing',
      scope: 'execution',
      detail: `The accepted History facts declare ${setup.length} setup checkpoints, not the exact ${SETUP_COUNT}.`,
    };
  }
  for (let index = 0; index < SETUP_COUNT; index += 1) {
    const expected = HISTORY_SETUP_CHECKPOINTS[index];
    const raw = setup[index];
    const label = `setup[${index}] (${String(expected?.checkpointId)})`;
    if (expected === undefined) continue;
    if (!isPlainRecord(raw)) return malformed(label, 'the checkpoint is not an object.');
    if (raw.checkpointId !== expected.checkpointId) {
      return malformed(label, `checkpoint id is ${String(raw.checkpointId)}.`);
    }
    if (raw.role !== expected.role) {
      return malformed(label, `cross-subject role is ${String(raw.role)}, not "${expected.role}".`);
    }
    if (raw.meaning !== expected.meaning) {
      return malformed(label, `meaning is ${String(raw.meaning)}, not "${expected.meaning}".`);
    }
    const tuple = readHistoryKernelTuple(raw);
    if (tuple === null) return malformed(label, 'the checkpoint tuple is not interpretable.');
    if (tuple.pastDepth !== expected.pastDepth || tuple.futureDepth !== expected.futureDepth) {
      return malformed(
        label,
        `the checkpoint tuple is ${tuple.pastDepth}/${tuple.futureDepth}, not the exact ${expected.pastDepth}/${expected.futureDepth}.`,
      );
    }
    if (tuple.baselineClean !== productBaselineClean(tuple.pastDepth, tuple.futureDepth)) {
      return malformed(label, 'the checkpoint baselineClean is not the product-exact value.');
    }
    if (typeof raw.meaningFingerprint !== 'string' || raw.meaningFingerprint.length === 0) {
      return {
        state: 'missing',
        scope: 'execution',
        detail: `${label}: the cross-subject meaning fingerprint is absent.`,
      };
    }
  }
  return null;
}

/**
 * Classifies the six ordered Undo/Redo transitions: cross-subject control
 * identity and order, dispatch count, the exact product expectation, currentness
 * (pre/post revision, observation/action-cycle binding, idle revision), the
 * exact pre-action baseline chain, and torn-recapture authority.
 *
 * The comparison of a well-formed observed tuple against its expectation is a
 * *product* comparison and is deliberately not an authority failure: it belongs
 * to the delivered product fact and maps to `FAIL`, never to `UNUSABLE`.
 */
function classifyActions(
  profile: ResolvedCorrectnessProfile,
  actions: readonly unknown[],
): AuthorityFinding | null {
  if (actions.length === 0) {
    return {
      state: 'missing',
      scope: 'execution',
      detail: 'The accepted History facts carry no transition observations.',
    };
  }
  if (actions.length !== ACTION_COUNT) {
    return {
      state: actions.length > ACTION_COUNT ? 'ambiguous' : 'missing',
      scope: 'execution',
      detail: `The accepted History facts declare ${actions.length} transitions, not the exact ${ACTION_COUNT}.`,
    };
  }
  const observationIds = new Set<string>();
  let previousAfter: HistoryKernelTupleView = PRE_ACTION_BASELINE;
  for (let index = 0; index < ACTION_COUNT; index += 1) {
    const step = HISTORY_ACTION_STEPS[index];
    const raw = actions[index];
    const label = `transition[${index}]`;
    if (step === undefined) continue;
    if (!isPlainRecord(raw)) return malformed(label, 'the transition is not an object.');
    const contract = HISTORY_CONTROLS[step.control];

    // Cross-subject identity and order: the exact step and the exact native
    // Undo/Redo control contract.
    if (raw.stepIndex !== step.stepIndex) {
      return malformed(label, `step index is ${String(raw.stepIndex)}, not ${step.stepIndex}.`);
    }
    if (raw.stepId !== step.stepId) {
      return malformed(label, `step id is ${String(raw.stepId)}, not "${step.stepId}".`);
    }
    if (raw.control !== step.control) {
      return malformed(label, `control is ${String(raw.control)}, not "${step.control}".`);
    }
    if (raw.controlAccessibleName !== contract.accessibleName) {
      return malformed(
        label,
        `control accessible name is ${String(raw.controlAccessibleName)}, not "${contract.accessibleName}".`,
      );
    }
    if (raw.controlTitle !== contract.title) {
      return malformed(
        label,
        `control title is ${String(raw.controlTitle)}, not "${contract.title}".`,
      );
    }
    if (raw.controlNativeTag !== HISTORY_CONTROL_NATIVE_TAG) {
      return malformed(
        label,
        `control native tag is ${String(raw.controlNativeTag)}, not "${HISTORY_CONTROL_NATIVE_TAG}".`,
      );
    }
    if (raw.controlButtonType !== HISTORY_CONTROL_BUTTON_TYPE) {
      return malformed(
        label,
        `control button type is ${String(raw.controlButtonType)}, not "${HISTORY_CONTROL_BUTTON_TYPE}".`,
      );
    }
    if (raw.controlVisible !== true) {
      return malformed(label, 'the native control was not visible before dispatch.');
    }
    if (raw.controlEnabledBeforeDispatch !== true) {
      return malformed(label, 'the native control was not enabled before dispatch.');
    }
    if (raw.dispatchCount !== 1) {
      return {
        state: 'malformed',
        scope: 'pre-action',
        detail: `${label}: dispatch count is ${String(raw.dispatchCount)}, not exactly one.`,
      };
    }
    if (raw.transitionObserved !== true) {
      return {
        state: 'missing',
        scope: 'pre-action',
        detail: `${label}: no causal post-action transition was observed.`,
      };
    }

    // Exact product expectation from the accepted transition contract.
    const expectedHistory = readHistoryKernelTuple(raw.expectedHistory);
    if (expectedHistory === null) {
      return malformed(label, 'the expected history tuple is not interpretable.');
    }
    if (!historyTupleWithCleanEquals(expectedHistory, step.expectedHistory)) {
      return malformed(
        label,
        `the expected history tuple is not the exact accepted ${step.expectedHistory.pastDepth}/${step.expectedHistory.futureDepth}.`,
      );
    }
    if (raw.expectedMeaning !== step.expectedMeaning) {
      return malformed(
        label,
        `the expected meaning is ${String(raw.expectedMeaning)}, not "${step.expectedMeaning}".`,
      );
    }

    // Currentness: strictly advancing revision, observation/action-cycle
    // identities bound to the revisions, and a current idle observation.
    const pre = integerOrNull(raw.preActionRevision);
    const post = integerOrNull(raw.postActionRevision);
    if (pre === null || pre < 0) {
      return malformed(label, 'the pre-action revision is not a non-negative integer.');
    }
    if (post === null || post < 0) {
      return malformed(label, 'the post-action revision is not a non-negative integer.');
    }
    if (!(post > pre)) {
      return {
        state: 'stale',
        scope: 'pre-action',
        detail: `${label}: the post-action revision ${post} does not strictly follow the armed pre-action revision ${pre}.`,
      };
    }
    const actionEpochId = stringOrNull(raw.actionEpochId);
    if (actionEpochId !== null && actionEpochId !== `history:${step.stepId}:${String(pre)}`) {
      return {
        state: 'stale',
        scope: 'pre-action',
        detail: `${label}: the Action Cycle epoch identity "${actionEpochId}" is not bound to the armed pre-action revision ${pre}.`,
      };
    }
    const observationId = stringOrNull(raw.observationId);
    if (observationId === null || observationId.length === 0) {
      return {
        state: 'missing',
        scope: 'pre-action',
        detail: `${label}: no accepted observation identity exists for the transition.`,
      };
    }
    if (observationIds.has(observationId)) {
      return {
        state: 'ambiguous',
        scope: 'pre-action',
        detail: `${label}: the observation identity "${observationId}" is reused by another transition.`,
      };
    }
    observationIds.add(observationId);
    if (observationId !== `history:${step.stepId}:${String(post)}`) {
      return {
        state: 'stale',
        scope: 'pre-action',
        detail: `${label}: the observation identity "${observationId}" is not bound to the post-action revision ${post}.`,
      };
    }
    const idle = raw.idle;
    if (!isPlainRecord(idle)) {
      return {
        state: 'missing',
        scope: 'pre-action',
        detail: `${label}: no post-transition idle observation was accepted.`,
      };
    }
    const idleStableFrames = integerOrNull(idle.stableFrames);
    const idleWaitedMs = numberOrNull(idle.waitedMs);
    const idleRevision = integerOrNull(idle.observationRevision);
    if (idleStableFrames === null || idleStableFrames < 0 || idleWaitedMs === null) {
      return malformed(label, 'the idle observation is not interpretable.');
    }
    if (
      profile.readiness.stableFrameRequired &&
      idleStableFrames < profile.readiness.stableFrames
    ) {
      return {
        state: 'stale',
        scope: 'pre-action',
        detail: `${label}: the idle observation reached ${idleStableFrames} stable frame(s), not the compiled required ${profile.readiness.stableFrames}.`,
      };
    }
    if (idleRevision !== post) {
      return {
        state: 'stale',
        scope: 'pre-action',
        detail: `${label}: the idle observation revision ${String(idleRevision)} is not current to the post-action revision ${post}.`,
      };
    }

    const before = readHistoryKernelTuple(raw.historyBefore);
    const after = readHistoryKernelTuple(raw.historyAfter);
    if (before === null) {
      return malformed(label, 'the pre-action history tuple is not interpretable.');
    }
    if (after === null) {
      return malformed(label, 'the post-action history tuple is not interpretable.');
    }
    if (before.baselineClean !== productBaselineClean(before.pastDepth, before.futureDepth)) {
      return malformed(label, 'the pre-action baselineClean is not the product-exact value.');
    }
    if (after.baselineClean !== productBaselineClean(after.pastDepth, after.futureDepth)) {
      return malformed(label, 'the post-action baselineClean is not the product-exact value.');
    }
    // Exact pre-action baseline correlation (ADR 0027 §3.2 B-R2, applied to the
    // cross-subject chain): the first armed baseline must be the exact H3
    // pre-action state and each later baseline must equal the previous accepted
    // post-action state.
    if (!historyTupleWithCleanEquals(before, previousAfter)) {
      return {
        state: 'stale',
        scope: 'pre-action',
        detail: `${label}: the pre-action baseline ${before.pastDepth}/${before.futureDepth} does not correlate with the previous accepted ${previousAfter.pastDepth}/${previousAfter.futureDepth}.`,
      };
    }
    previousAfter = after;

    if (typeof raw.historyTupleExact !== 'boolean') {
      return malformed(label, 'the delivered tuple-exactness fact is not interpretable.');
    }
    if (typeof raw.meaningStructurallyEqual !== 'boolean') {
      return malformed(label, 'the delivered meaning-structural fact is not interpretable.');
    }
    const meaningFingerprint = stringOrNull(raw.meaningFingerprint);
    if (meaningFingerprint === null || meaningFingerprint.length === 0) {
      return {
        state: 'missing',
        scope: 'execution',
        detail: `${label}: the observed normalized-meaning fingerprint is absent.`,
      };
    }
    const expectedMeaningFingerprint = stringOrNull(raw.expectedMeaningFingerprint);
    if (expectedMeaningFingerprint === null || expectedMeaningFingerprint.length === 0) {
      return {
        state: 'missing',
        scope: 'execution',
        detail: `${label}: the expected normalized-meaning fingerprint is absent.`,
      };
    }
    const tornRecaptureCount = integerOrNull(raw.tornRecaptureCount);
    if (tornRecaptureCount === null || tornRecaptureCount < 0) {
      return malformed(label, 'the torn-recapture count is not interpretable.');
    }
    if (tornRecaptureCount !== 0) {
      return {
        state: 'torn',
        scope: 'pre-action',
        detail: `${label}: ${tornRecaptureCount} torn candidate(s) were recaptured; the transition authority is torn.`,
      };
    }
  }
  return null;
}

/**
 * Classifies the final whole-document tuple. A well-formed tuple that is not the
 * exact `H3` is a product mismatch (`FAIL`); a tuple that does not correlate
 * with the last accepted transition is unusable authority.
 */
function classifyFinal(
  actions: readonly unknown[],
  finalHistory: unknown,
): AuthorityFinding | null {
  const final = readHistoryKernelTuple(finalHistory);
  if (final === null) {
    return {
      state: 'missing',
      scope: 'execution',
      detail: 'The accepted History final tuple is absent or not interpretable.',
    };
  }
  if (final.baselineClean !== productBaselineClean(final.pastDepth, final.futureDepth)) {
    return malformed('finalHistory', 'the baselineClean is not the product-exact value.');
  }
  const lastAction = actions[actions.length - 1];
  const lastAfter = isPlainRecord(lastAction)
    ? readHistoryKernelTuple(lastAction.historyAfter)
    : null;
  if (lastAfter !== null && !historyTupleWithCleanEquals(final, lastAfter)) {
    return {
      state: 'stale',
      scope: 'pre-action',
      detail: `The final tuple ${final.pastDepth}/${final.futureDepth} does not correlate with the last accepted transition ${lastAfter.pastDepth}/${lastAfter.futureDepth}.`,
    };
  }
  return null;
}

/**
 * Recomputes the accepted whole-document History authority from the delivered
 * facts. Every failure is a precise unusable authority state; only an exact,
 * mutually consistent, current chain is `current`. No boolean fact may rescue a
 * non-current authority.
 */
function classifyAuthority(
  profile: ResolvedCorrectnessProfile,
  facts: HistoryKernelFacts,
): AuthorityClassification {
  const findings: AuthorityFinding[] = [];
  const target = classifyTarget(facts);
  if (target !== null) findings.push(target);
  const readiness = classifyReadiness(profile, facts);
  if (readiness !== null) findings.push(readiness);
  const setup = classifySetup(Array.isArray(facts.setup) ? facts.setup : []);
  if (setup !== null) findings.push(setup);
  const actions = Array.isArray(facts.actions) ? facts.actions : [];
  const actionFinding = classifyActions(profile, actions);
  if (actionFinding !== null) findings.push(actionFinding);
  const final = classifyFinal(actions, facts.finalHistory);
  if (final !== null) findings.push(final);

  const first = findings[0];
  if (first === undefined) {
    return { state: 'current', scope: null, detail: 'current', findings };
  }
  return { state: first.state, scope: first.scope, detail: first.detail, findings };
}

interface EvidenceConsumption {
  readonly consumed: readonly string[];
  readonly authoritative: boolean;
  readonly authorityState: HistoryAuthorityState;
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
  facts: readonly HistoryEvidenceFact[],
  issues: HistoryKernelIssue[],
): EvidenceConsumption {
  const checkId = contract.checkId;
  const byId = new Map<string, HistoryEvidenceFact>();
  for (const fact of facts) {
    if (isPlainRecord(fact) && typeof fact.evidenceId === 'string') {
      byId.set(fact.evidenceId, fact as unknown as HistoryEvidenceFact);
    }
  }
  const globalDeclared = new Set(profile.requiredAuthoritativeEvidence);
  const consumed: string[] = [];
  let authorityState: HistoryAuthorityState = 'current';

  for (const requiredId of sortStrings(contract.requiredEvidence)) {
    if (!globalDeclared.has(requiredId)) {
      issues.push(
        issue(
          'HISTORY_KERNEL_EVIDENCE_UNDECLARED',
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
          'HISTORY_KERNEL_EVIDENCE_DIAGNOSTIC_ONLY',
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
          'HISTORY_KERNEL_EVIDENCE_UNDECLARED',
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
 * A structured evaluator fact is well formed only when authority/currentness
 * are closed values and the chain-agreement/mismatch facts are explicit
 * booleans. An incomplete or legacy-shaped record is never interpreted as a
 * final status.
 */
function isWellFormedEvaluatorFact(value: unknown): value is HistoryEvaluatorFact {
  return (
    isPlainRecord(value) &&
    typeof value.checkId === 'string' &&
    isHistoryAuthorityState(value.authority) &&
    isHistoryFactCurrentness(value.currentness) &&
    typeof value.sourcesAgree === 'boolean' &&
    typeof value.mismatch === 'boolean'
  );
}

/**
 * Validates the accepted History check facts against the compiled required-check
 * set: a declared check may have exactly one explicit structured fact, and an
 * undeclared or legacy-shaped check fact is rejected without being consumed.
 */
function validateCheckFacts(
  profile: ResolvedCorrectnessProfile,
  facts: HistoryKernelFacts,
  issues: HistoryKernelIssue[],
): void {
  const declaredIds = new Set(profile.requiredChecks.map((entry) => entry.checkId));
  const seenFactIds = new Set<string>();
  for (const fact of Array.isArray(facts.checks) ? facts.checks : []) {
    if (!isPlainRecord(fact) || typeof fact.checkId !== 'string') {
      issues.push(
        issue('HISTORY_KERNEL_FACT_STATUS_UNKNOWN', 'A History check fact has no check id.'),
      );
      continue;
    }
    if (seenFactIds.has(fact.checkId)) {
      issues.push(
        issue(
          'HISTORY_KERNEL_FACT_CHECK_DUPLICATE',
          `History check fact "${fact.checkId}" appears more than once.`,
          fact.checkId,
        ),
      );
      continue;
    }
    seenFactIds.add(fact.checkId);
    if (!declaredIds.has(fact.checkId)) {
      issues.push(
        issue(
          'HISTORY_KERNEL_FACT_CHECK_UNKNOWN',
          `History check fact "${fact.checkId}" is not a declared required check.`,
          fact.checkId,
        ),
      );
    }
    if (!isWellFormedEvaluatorFact(fact)) {
      issues.push(
        issue(
          'HISTORY_KERNEL_FACT_AUTHORITY_UNKNOWN',
          `History check fact "${fact.checkId}" carries no explicit structured authority/currentness/chain-agreement/mismatch facts.`,
          fact.checkId,
        ),
      );
    }
  }
}

// ── Defensive projections for `actual` ───────────────────────────────────────

function projectSetup(setup: readonly unknown[]): readonly HistoryKernelSetupProjection[] {
  return setup.map((raw) => {
    if (!isPlainRecord(raw)) {
      return {
        checkpointId: null,
        role: null,
        meaning: null,
        pastDepth: null,
        futureDepth: null,
        baselineClean: null,
        baselineCleanProductExact: null,
        meaningFingerprint: null,
      };
    }
    const past = integerOrNull(raw.pastDepth);
    const future = integerOrNull(raw.futureDepth);
    const clean = typeof raw.baselineClean === 'boolean' ? raw.baselineClean : null;
    return {
      checkpointId: stringOrNull(raw.checkpointId),
      role: stringOrNull(raw.role),
      meaning: stringOrNull(raw.meaning),
      pastDepth: past,
      futureDepth: future,
      baselineClean: clean,
      baselineCleanProductExact:
        clean === null || past === null || future === null
          ? null
          : clean === productBaselineClean(past, future),
      meaningFingerprint: stringOrNull(raw.meaningFingerprint),
    };
  });
}

function projectTransitions(
  actions: readonly unknown[],
): readonly HistoryKernelTransitionProjection[] {
  return actions.map((raw, order) => {
    if (!isPlainRecord(raw)) {
      return emptyTransitionProjection(order);
    }
    const idle = isPlainRecord(raw.idle) ? raw.idle : null;
    const post = integerOrNull(raw.postActionRevision);
    const idleRevision = idle === null ? null : integerOrNull(idle.observationRevision);
    const meaningFingerprint = stringOrNull(raw.meaningFingerprint);
    const expectedMeaningFingerprint = stringOrNull(raw.expectedMeaningFingerprint);
    return {
      stepIndex: integerOrNull(raw.stepIndex),
      stepId: stringOrNull(raw.stepId),
      order,
      control: stringOrNull(raw.control),
      controlAccessibleName: stringOrNull(raw.controlAccessibleName),
      controlTitle: stringOrNull(raw.controlTitle),
      controlNativeTag: stringOrNull(raw.controlNativeTag),
      controlButtonType: stringOrNull(raw.controlButtonType),
      controlVisible: typeof raw.controlVisible === 'boolean' ? raw.controlVisible : null,
      controlEnabledBeforeDispatch:
        typeof raw.controlEnabledBeforeDispatch === 'boolean'
          ? raw.controlEnabledBeforeDispatch
          : null,
      dispatchCount: integerOrNull(raw.dispatchCount),
      actionEpochId: stringOrNull(raw.actionEpochId),
      observationId: stringOrNull(raw.observationId),
      preActionRevision: integerOrNull(raw.preActionRevision),
      postActionRevision: post,
      revisionAdvanced:
        integerOrNull(raw.preActionRevision) === null || post === null
          ? null
          : post > (integerOrNull(raw.preActionRevision) as number),
      idle:
        idle === null
          ? null
          : {
              stableFrames: integerOrNull(idle.stableFrames),
              waitedMs: numberOrNull(idle.waitedMs),
              observationRevision: idleRevision,
            },
      idleCurrent: idleRevision === null || post === null ? null : idleRevision === post,
      historyBefore: readHistoryKernelTuple(raw.historyBefore),
      historyAfter: readHistoryKernelTuple(raw.historyAfter),
      expectedHistory: readHistoryKernelTuple(raw.expectedHistory),
      historyTupleExact: typeof raw.historyTupleExact === 'boolean' ? raw.historyTupleExact : null,
      expectedMeaning: stringOrNull(raw.expectedMeaning),
      meaningFingerprint,
      expectedMeaningFingerprint,
      meaningFingerprintEqual:
        meaningFingerprint === null || expectedMeaningFingerprint === null
          ? null
          : meaningFingerprint === expectedMeaningFingerprint,
      meaningStructurallyEqual:
        typeof raw.meaningStructurallyEqual === 'boolean' ? raw.meaningStructurallyEqual : null,
      transitionObserved:
        typeof raw.transitionObserved === 'boolean' ? raw.transitionObserved : null,
      tornRecaptureCount: integerOrNull(raw.tornRecaptureCount),
    };
  });
}

function emptyTransitionProjection(order: number): HistoryKernelTransitionProjection {
  return {
    stepIndex: null,
    stepId: null,
    order,
    control: null,
    controlAccessibleName: null,
    controlTitle: null,
    controlNativeTag: null,
    controlButtonType: null,
    controlVisible: null,
    controlEnabledBeforeDispatch: null,
    dispatchCount: null,
    actionEpochId: null,
    observationId: null,
    preActionRevision: null,
    postActionRevision: null,
    revisionAdvanced: null,
    idle: null,
    idleCurrent: null,
    historyBefore: null,
    historyAfter: null,
    expectedHistory: null,
    historyTupleExact: null,
    expectedMeaning: null,
    meaningFingerprint: null,
    expectedMeaningFingerprint: null,
    meaningFingerprintEqual: null,
    meaningStructurallyEqual: null,
    transitionObserved: null,
    tornRecaptureCount: null,
  };
}

/** The exact accepted `H0`…`H3` cross-subject setup expectation. */
function expectedSetupContract(): readonly Record<string, unknown>[] {
  return HISTORY_SETUP_CHECKPOINTS.map((entry) => ({
    checkpointId: entry.checkpointId,
    role: entry.role,
    pastDepth: entry.pastDepth,
    futureDepth: entry.futureDepth,
    baselineClean: productBaselineClean(entry.pastDepth, entry.futureDepth),
    meaning: entry.meaning,
  }));
}

/** The exact accepted six-transition identity/order/expectation. */
function expectedTransitionContract(): readonly Record<string, unknown>[] {
  return HISTORY_ACTION_STEPS.map((step) => ({
    stepIndex: step.stepIndex,
    stepId: step.stepId,
    control: step.control,
    controlAccessibleName: HISTORY_CONTROLS[step.control].accessibleName,
    controlTitle: HISTORY_CONTROLS[step.control].title,
    controlNativeTag: HISTORY_CONTROL_NATIVE_TAG,
    controlButtonType: HISTORY_CONTROL_BUTTON_TYPE,
    expectedHistory: {
      pastDepth: step.expectedHistory.pastDepth,
      futureDepth: step.expectedHistory.futureDepth,
      baselineClean: step.expectedHistory.baselineClean,
    },
    expectedMeaning: step.expectedMeaning,
  }));
}

function expectedPayload(
  profile: ResolvedCorrectnessProfile,
  contract: ResolvedCheckContract,
  facts: HistoryKernelFacts,
): Record<string, unknown> {
  return {
    schema: contract.expectedSchema,
    evaluator: contract.evaluator,
    oracleProfileId: profile.oracle.oracleProfileId,
    checkId: contract.checkId,
    readinessProfileId: profile.readiness.profileId,
    timingCategory: profile.readiness.deadlineCategory,
    deadlineMs: profile.readiness.deadlineMs,
    retainedLayoutId: stringOrNull(facts.retainedLayoutId),
    preActionBaseline: { ...PRE_ACTION_BASELINE },
    setupCheckpoints: expectedSetupContract(),
    transitions: expectedTransitionContract(),
    requiredEvidence: sortStrings(contract.requiredEvidence),
    toleranceRefs: sortStrings(contract.toleranceRefs),
    visualRefs: sortStrings(contract.visualRefs),
    normalizationRef: contract.normalizationRef,
  };
}

/** Defensive projection of the accepted primitive Oracle facts for `actual`. */
function projectOracleFacts(facts: HistoryOracleFactsView | null): Record<string, unknown> | null {
  if (facts === null) return null;
  return {
    authority: facts.authority,
    chainAgreement: facts.chainAgreement === true,
    retainedLayoutId: stringOrNull(facts.retainedLayoutId),
    setup: Array.isArray(facts.setup)
      ? facts.setup.map((entry) => ({
          checkpointId: stringOrNull(entry.checkpointId),
          role: stringOrNull(entry.role),
          meaning: stringOrNull(entry.meaning),
          pastDepth: numberOrNull(entry.pastDepth),
          futureDepth: numberOrNull(entry.futureDepth),
          baselineClean: entry.baselineClean === true,
          meaningFingerprint: stringOrNull(entry.meaningFingerprint),
        }))
      : null,
    transitions: Array.isArray(facts.transitions)
      ? facts.transitions.map((entry) => ({
          order: numberOrNull(entry.order),
          stepIndex: numberOrNull(entry.stepIndex),
          stepId: stringOrNull(entry.stepId),
          control: stringOrNull(entry.control),
          controlAccessibleName: stringOrNull(entry.controlAccessibleName),
          controlTitle: stringOrNull(entry.controlTitle),
          controlNativeTag: stringOrNull(entry.controlNativeTag),
          controlButtonType: stringOrNull(entry.controlButtonType),
          controlVisible: entry.controlVisible === true,
          controlEnabledBeforeDispatch: entry.controlEnabledBeforeDispatch === true,
          dispatchCount: numberOrNull(entry.dispatchCount),
          actionEpochId: stringOrNull(entry.actionEpochId),
          observationId: stringOrNull(entry.observationId),
          preActionRevision: numberOrNull(entry.preActionRevision),
          postActionRevision: numberOrNull(entry.postActionRevision),
          revisionAdvanced: entry.revisionAdvanced === true,
          idle:
            entry.idle === null
              ? null
              : {
                  stableFrames: numberOrNull(entry.idle.stableFrames),
                  waitedMs: numberOrNull(entry.idle.waitedMs),
                  observationRevision: numberOrNull(entry.idle.observationRevision),
                },
          historyBefore: entry.historyBefore === null ? null : { ...entry.historyBefore },
          historyAfter: entry.historyAfter === null ? null : { ...entry.historyAfter },
          expectedHistory: entry.expectedHistory === null ? null : { ...entry.expectedHistory },
          historyTupleExact: entry.historyTupleExact === true,
          expectedMeaning: stringOrNull(entry.expectedMeaning),
          meaningFingerprint: stringOrNull(entry.meaningFingerprint),
          expectedMeaningFingerprint: stringOrNull(entry.expectedMeaningFingerprint),
          meaningStructurallyEqual: entry.meaningStructurallyEqual === true,
          transitionObserved: entry.transitionObserved === true,
          tornRecaptureCount: numberOrNull(entry.tornRecaptureCount),
        }))
      : null,
    finalHistory: facts.finalHistory === null ? null : { ...facts.finalHistory },
    checks: Array.isArray(facts.checks)
      ? facts.checks.map((entry) => ({
          checkId: stringOrNull(entry.checkId),
          predicateMet: entry.predicateMet === true,
        }))
      : [],
  };
}

function actualPayload(
  contract: ResolvedCheckContract,
  facts: HistoryKernelFacts,
  authorityState: HistoryAuthorityState,
  authorityScope: HistoryAuthorityScope | null,
  fact: HistoryEvaluatorFact | null,
  evidence: EvidenceConsumption,
  status: CheckResultStatus,
): Record<string, unknown> {
  const actions = Array.isArray(facts.actions) ? facts.actions : [];
  const firstAction = actions[0];
  const preActionBaseline = isPlainRecord(firstAction)
    ? readHistoryKernelTuple(firstAction.historyBefore)
    : null;
  const readiness = facts.readiness;
  const observation = isPlainRecord(readiness) ? readiness.observation : null;
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
    retainedLayoutId: stringOrNull(facts.retainedLayoutId),
    preActionBaseline: preActionBaseline === null ? null : { ...preActionBaseline },
    setup: projectSetup(Array.isArray(facts.setup) ? facts.setup : []),
    transitions: projectTransitions(actions),
    finalHistory: readHistoryKernelTuple(facts.finalHistory),
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
 * A trustworthy product mismatch (wrong post-transition tuple, wrong restored
 * normalized meaning, or a final tuple that is not the exact `H3`) after valid,
 * current, interpretable authority is `FAIL`; a missing, stale, torn, ambiguous,
 * malformed, wrong-target, or otherwise non-authoritative pre-action/target/
 * execution/readiness authority, an absent or legacy-shaped accepted fact, a
 * non-current evaluator authority, or a non-authoritative required evidence
 * role is `UNUSABLE`. No boolean check result is translated into a status.
 */
function resolveStatus(
  authority: AuthorityClassification,
  fact: HistoryEvaluatorFact | null,
  evidence: EvidenceConsumption,
): { status: CheckResultStatus; authority: HistoryAuthorityState } {
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

function authorityIssueCode(scope: HistoryAuthorityScope | null): HistoryKernelIssueCode {
  switch (scope) {
    case 'target':
      return 'HISTORY_KERNEL_TARGET_AUTHORITY_UNUSABLE';
    case 'readiness':
      return 'HISTORY_KERNEL_READINESS_AUTHORITY_UNUSABLE';
    case 'pre-action':
      return 'HISTORY_KERNEL_PRE_ACTION_AUTHORITY_UNUSABLE';
    default:
      return 'HISTORY_KERNEL_EXECUTION_AUTHORITY_UNUSABLE';
  }
}

function runHistoryKernel(input: HistoryKernelInput): HistoryKernelResult {
  const { profile, route, actionCycle, facts } = input;
  const issues = validateProfile(profile, route, actionCycle);
  if (issues.length > 0) {
    return { kind: HISTORY_KERNEL_EVALUATOR, ok: false, checks: [], issues };
  }

  if (facts.evaluator !== HISTORY_KERNEL_EVALUATOR) {
    issues.push(
      issue(
        'HISTORY_KERNEL_FACTS_EVALUATOR_MISMATCH',
        `History facts declare evaluator "${String(facts.evaluator)}" instead of "${HISTORY_KERNEL_EVALUATOR}".`,
      ),
    );
  }

  validateCheckFacts(profile, facts, issues);
  const authority = classifyAuthority(profile, facts);
  if (authority.state !== 'current' && authority.scope === 'readiness') {
    // The readiness policy divergence gets its own precise issue; the general
    // authority issue is emitted for every unusable readiness state.
    if (authority.state === 'malformed') {
      issues.push(issue('HISTORY_KERNEL_READINESS_POLICY_MISMATCH', authority.detail));
    }
  }
  if (authority.state !== 'current') {
    issues.push(issue(authorityIssueCode(authority.scope), authority.detail));
  }

  const factById = new Map<string, HistoryEvaluatorFact>();
  for (const fact of Array.isArray(facts.checks) ? facts.checks : []) {
    if (
      isPlainRecord(fact) &&
      typeof fact.checkId === 'string' &&
      isWellFormedEvaluatorFact(fact) &&
      !factById.has(fact.checkId)
    ) {
      factById.set(fact.checkId, fact as unknown as HistoryEvaluatorFact);
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
          'HISTORY_KERNEL_FACT_CHECK_MISSING',
          `No accepted History evaluator fact exists for declared check "${contract.checkId}".`,
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
        expectedPayload(profile, contract, facts),
        actualPayload(
          contract,
          facts,
          resolved.authority,
          authority.state === 'current' ? null : authority.scope,
          fact,
          evidence,
          resolved.status,
        ),
        evidence.consumed,
      ),
    );
  }

  return { kind: HISTORY_KERNEL_EVALUATOR, ok: true, checks, issues };
}

/**
 * The cross-subject History final kernel. It evaluates the profile's declared
 * History checks from the accepted Oracle, setup, transition, readiness,
 * currentness, and evidence facts.
 */
export function evaluateHistoryChecks(input: HistoryKernelInput): HistoryKernelResult {
  return runHistoryKernel(input);
}

/** Runtimes dispatch to exactly one cross-subject History kernel kind. */
export function historyKernelKindForEvaluator(
  evaluatorKind: string | null | undefined,
): HistoryKernelKind | null {
  return evaluatorKind === HISTORY_KERNEL_EVALUATOR ? HISTORY_KERNEL_EVALUATOR : null;
}
