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
  readAcceptedRasterAuthority,
  validateRasterRecord,
  type ImageRasterRecordView,
} from '../contracts/raster';
import { isPlainRecord } from '../contracts/result-agreement';
import {
  CHECK_RESULT_CONTRACT_SCHEMA_VERSION,
  RESOLVED_CORRECTNESS_PROFILE_SCHEMA_VERSION,
} from '../contracts/schema-versions';

/**
 * P7-B B1-D inactive final compiled-profile kernel for Image upload/replacement
 * (ADR 0028 §3 B1-D; reconciled to structured facts by ADR 0029 §4 B2-B3).
 *
 * An Image upload/replacement is proven by the accepted `image-upload-replace`
 * Oracle (WP5 Slice 5-C; supervisor R6/R7/R10). That Oracle consumes one accepted
 * coherent observation plus the accepted live raster authority and resolves the
 * declared checks (`image.semantic-transition`, `image.raster-current`,
 * `image.frame-stable`, `image.structural-visual`, and — replacement only —
 * `image.content-distinct`). The same accepted Action Cycle also reports a
 * signal-first raster-readiness observation: one non-extending deadline, a
 * 100 ms no-signal watchdog, and the bounded 100/200/250 ms fallback cadence.
 *
 * This kernel is the *inactive final* consumer of those facts. It receives
 * exactly the compiled `ResolvedCorrectnessProfile`, the route the runtime
 * resolved, the Action Cycle correctness identity that observed the action, and
 * the accepted Image facts:
 *
 *  1. the explicit structured per-check evaluator facts (authority,
 *     currentness, source agreement, and product mismatch) plus the raw named
 *     primitive Image Oracle facts the inactive B2-B3 adapter projected from the
 *     delivered Oracle observations;
 *  2. the accepted raster-readiness facts (the compiled policy the runtime
 *     applied plus the observed outcome, wake source, fallback counters and
 *     non-convergence detail);
 *  3. the accepted live raster record (raster schema v3 `image-source-v2` arm);
 *  4. the accepted resolved resource/expected-frame facts; and
 *  5. the observed evidence roles for the Action Cycle.
 *
 * It returns one complete, field-rich `CorrectnessCheckResult` per declared
 * required check — or, when the compiled profile itself is not trustworthy, no
 * fabricated checks at all.
 *
 * Every correctness input is read from the compiled profile. This module owns no
 * required-check list, no check id, no tolerance/visual/normalization literal,
 * no deadline/watchdog/cadence constant, no fallback id, and no
 * Subject-name/family/scenario branch; it never reloads an authoring catalogue.
 * The accepted Image meaning is preserved exactly:
 *
 *  - an exact, current transition is `PASS`;
 *  - a trustworthy product mismatch or a trustworthy raster non-convergence at
 *    the one deadline is `FAIL`;
 *  - a missing / stale / torn / wrong-target / malformed raster, source, or blob
 *    authority, an absent accepted fact, a non-authoritative required evidence
 *    role, or a malformed evaluator authority is `UNUSABLE`;
 *  - a diagnostic-only item (including a diagnostic screenshot) can never rescue
 *    a required check.
 *
 * The legacy aggregate `harnessInvalid` flag and the legacy per-check boolean
 * `passed`/`unusable` are deliberately absent from the fact contract: authority,
 * currentness, source agreement, and product mismatch are carried as separate
 * structured facts so no boolean check result is translated into a final status.
 *
 * The kernel is deliberately inactive. Nothing here is imported by the active
 * executor, Oracle, classifier, writer, or CLI, and no module under `src/runtime`
 * or `src/oracles` is imported in return: the fact contract below is
 * structurally satisfied by the delivered `ImageOracleEvaluation` and raster
 * observations, so the atomic B2 cutover can pass the delivered facts in without
 * this module depending on active machinery.
 */

/** The single delivered Image evaluator family this kernel owns. */
export const IMAGE_KERNEL_KINDS = ['image-upload-replace'] as const;
export type ImageKernelKind = (typeof IMAGE_KERNEL_KINDS)[number];

/** The compiled Oracle discriminant the Image route resolves. */
export const IMAGE_KERNEL_EVALUATOR = 'image-upload-replace';

/**
 * The closed per-check evaluator discriminants the `image-upload-replace` Oracle
 * declares (`image-structural` for every raster/semantic check and
 * `renderer-transform` for the frame check). A compiled profile that declares a
 * different check evaluator cannot be interpreted by this kernel.
 */
export const IMAGE_KERNEL_CHECK_EVALUATORS = ['image-structural', 'renderer-transform'] as const;

/**
 * Closed evidence-availability vocabulary. Only `authoritative` evidence is
 * current and interpretable; every other state makes a required check
 * `UNUSABLE`. `diagnostic-only` is the single role that must never satisfy a
 * required check.
 */
export const IMAGE_EVIDENCE_AVAILABILITY = [
  'authoritative',
  'ambiguous',
  'diagnostic-only',
  'malformed',
  'missing',
  'stale',
  'torn',
] as const;
export type ImageEvidenceAvailability = (typeof IMAGE_EVIDENCE_AVAILABILITY)[number];

export function isImageEvidenceAvailability(value: unknown): value is ImageEvidenceAvailability {
  return (
    typeof value === 'string' && (IMAGE_EVIDENCE_AVAILABILITY as readonly string[]).includes(value)
  );
}

/** One accepted evidence fact the runtime actually observed for a check. */
export interface ImageEvidenceFact {
  readonly evidenceId: string;
  readonly availability: ImageEvidenceAvailability;
}

/** Closed authority state recorded in every `actual` interpretation. */
export const IMAGE_AUTHORITY_STATES = [
  'ambiguous',
  'current',
  'malformed',
  'missing',
  'stale',
  'torn',
  'unavailable',
  'wrong-target',
] as const;
export type ImageAuthorityState = (typeof IMAGE_AUTHORITY_STATES)[number];

/** Closed raster-readiness outcomes. */
export const IMAGE_READINESS_OUTCOMES = [
  'converged',
  'deadline-exceeded',
  'not-attempted',
  'unusable',
] as const;
export type ImageReadinessOutcome = (typeof IMAGE_READINESS_OUTCOMES)[number];

export function isImageReadinessOutcome(value: unknown): value is ImageReadinessOutcome {
  return (
    typeof value === 'string' && (IMAGE_READINESS_OUTCOMES as readonly string[]).includes(value)
  );
}

/**
 * Closed structured currentness vocabulary for one accepted evaluator fact
 * (ADR 0029 §4 B2-B). Currentness is an explicit structured fact recorded per
 * check; it is never a final result status.
 */
export const IMAGE_FACT_CURRENTNESS = ['current', 'stale', 'torn', 'unavailable'] as const;
export type ImageFactCurrentness = (typeof IMAGE_FACT_CURRENTNESS)[number];

/** Projects a structured authority state onto the closed currentness domain. */
export function imageCurrentnessForAuthority(authority: ImageAuthorityState): ImageFactCurrentness {
  if (authority === 'current') return 'current';
  if (authority === 'stale') return 'stale';
  if (authority === 'torn') return 'torn';
  return 'unavailable';
}

function isImageAuthorityState(value: unknown): value is ImageAuthorityState {
  return typeof value === 'string' && (IMAGE_AUTHORITY_STATES as readonly string[]).includes(value);
}

function isImageFactCurrentness(value: unknown): value is ImageFactCurrentness {
  return typeof value === 'string' && (IMAGE_FACT_CURRENTNESS as readonly string[]).includes(value);
}

/**
 * One accepted per-check Image evaluator fact in explicit structured form
 * (ADR 0029 §4 B2-B). The legacy boolean `passed`/`unusable` pair is replaced by
 * structured authority, currentness, source-agreement, and product-mismatch
 * facts so the kernel maps them to a status from explicit structure instead of
 * translating a boolean check result.
 */
export interface ImageEvaluatorFact {
  readonly checkId: string;
  /** Structured authority state of the accepted evaluator fact. */
  readonly authority: ImageAuthorityState;
  /** Structured currentness of the accepted evaluator fact. */
  readonly currentness: ImageFactCurrentness;
  /** Whether the independent page-observed/resolved source sources agreed. */
  readonly sourcesAgree: boolean;
  /** A trustworthy product mismatch under a current authority. */
  readonly mismatch: boolean;
}

/** One raw primitive per-check predicate of the accepted Image Oracle. */
export interface ImagePrimitiveCheckFactView {
  readonly checkId: string;
  readonly predicateMet: boolean;
}

/**
 * The additive named primitive Image Oracle facts the inactive B2-B3 adapter
 * consumed. Every field is a raw primitive observation (structured authority, an
 * independent source-agreement primitive, and one predicate per selected
 * check); no field is a legacy composite boolean check result.
 */
export interface ImageOracleFactsView {
  readonly authority: 'current' | 'malformed';
  readonly sourceAgreement: boolean;
  readonly checks: readonly ImagePrimitiveCheckFactView[];
}

/** A finite `{ x, y }` vector, structurally identical to the accepted points. */
export interface ImageKernelVector {
  readonly x: number;
  readonly y: number;
}

/** One accepted resolved-resource probe declaration. */
export interface ImageKernelResourceProbeFact {
  readonly id: string;
  readonly x: { readonly numerator: number; readonly denominator: number };
  readonly y: { readonly numerator: number; readonly denominator: number };
  readonly expectedRgba: readonly number[];
  readonly channelTolerance: number;
}

/** The accepted resolved resource behind one checkpoint. */
export interface ImageKernelResourceFact {
  readonly logicalId: string;
  readonly version: number;
  readonly sha256: string;
  readonly byteLength: number;
  readonly mimeType: string;
  readonly dimensions: { readonly width: number; readonly height: number };
  readonly probes: readonly ImageKernelResourceProbeFact[];
}

/** The accepted upload-region digest/probe facts a replacement must differ from. */
export interface ImageKernelAcceptedUploadFact {
  readonly sourceSha256: string;
  readonly rgbaSha256: string;
  readonly probes: readonly {
    readonly probeId: string;
    readonly rgba: readonly number[];
  }[];
}

/**
 * The compiled readiness policy the runtime applied. Every field is the
 * authority the compiled profile carries; a divergent runtime constant is a
 * contract disagreement rather than a policy that may silently override the
 * profile.
 */
export interface ImageReadinessPolicyFact {
  readonly profileId: string;
  readonly deadlineCategory: string;
  readonly deadlineMs: number;
  readonly signalWatchdogMs: number;
  readonly fallbackCadenceMs: readonly number[];
  readonly stableFrames: number;
  readonly quiescenceRequired: boolean;
  readonly stableFrameRequired: boolean;
}

/** The observed signal-first readiness execution of one Image Action Cycle. */
export interface ImageReadinessObservationFact {
  readonly outcome: ImageReadinessOutcome;
  /** Meaningful when `outcome` is `unusable`; otherwise recorded as given. */
  readonly authority: ImageAuthorityState;
  readonly wakeSource: string | null;
  readonly fallbackPollCount: number;
  readonly watchdogWaits: number;
  readonly attempts: number;
  readonly tornCount: number;
  readonly mismatches: readonly string[];
  readonly detail: string | null;
}

/** Accepted readiness facts: the compiled policy plus the observed execution. */
export interface ImageReadinessFact {
  readonly policy: ImageReadinessPolicyFact;
  readonly observation: ImageReadinessObservationFact;
}

/** The route a kernel is asked to evaluate. Passed in; never selected internally. */
export interface ImageKernelRoute {
  readonly subjectId: string;
  readonly capability: Capability;
  readonly variant: string | null;
}

/**
 * Accepted Image evaluator facts plus the accepted readiness/raster/resource
 * facts and the observed evidence roles.
 *
 * The legacy aggregate `harnessInvalid` flag and the legacy per-check
 * `passed`/`unusable` booleans are deliberately absent. `checks` carries the
 * explicit structured authority/currentness/source-agreement/mismatch facts for
 * every declared check, and `oracleFacts` carries the raw named primitive Image
 * Oracle facts the inactive B2-B3 adapter projected. `mode`, `targetId`,
 * `expectedLayoutId`, `expectedFrame`, `expectedResource`, and `acceptedUpload`
 * are the accepted checkpoint facts the Oracle consumed; `raster` is the accepted
 * live raster record (raster schema v3 closed union) and is typed `unknown` so
 * the kernel validates it through the accepted structural contract rather than
 * trusting a caller-supplied shape.
 */
export interface ImageKernelFacts {
  readonly evaluator: typeof IMAGE_KERNEL_EVALUATOR;
  readonly mode: 'upload' | 'replacement';
  readonly targetId: string;
  readonly expectedLayoutId: string;
  readonly expectedFrame: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
    readonly rotation: number;
  };
  readonly expectedResource: ImageKernelResourceFact;
  readonly acceptedUpload: ImageKernelAcceptedUploadFact | null;
  /** The explicit structured per-check evaluator facts the adapter projected. */
  readonly checks: readonly ImageEvaluatorFact[];
  /** The raw named primitive Image Oracle facts, or `null` when none ran. */
  readonly oracleFacts: ImageOracleFactsView | null;
  readonly diagnostics: readonly { readonly code: string; readonly detail: string }[];
  readonly raster: unknown;
  readonly readiness: ImageReadinessFact;
  readonly evidence: readonly ImageEvidenceFact[];
}

/** Closed kernel issue vocabulary; deliberately local to the inactive kernel. */
export const IMAGE_KERNEL_ISSUE_CODES = [
  'IMAGE_KERNEL_PROFILE_NOT_OBJECT',
  'IMAGE_KERNEL_PROFILE_SCHEMA_UNSUPPORTED',
  'IMAGE_KERNEL_PROFILE_FINGERPRINT_MISSING',
  'IMAGE_KERNEL_PROFILE_FINGERPRINT_INVALID',
  'IMAGE_KERNEL_PROFILE_FINGERPRINT_MISMATCH',
  'IMAGE_KERNEL_COMPONENT_FINGERPRINT_INVALID',
  'IMAGE_KERNEL_ROUTE_MISMATCH',
  'IMAGE_KERNEL_ORACLE_EVALUATOR_UNSUPPORTED',
  'IMAGE_KERNEL_CHECK_EVALUATOR_UNSUPPORTED',
  'IMAGE_KERNEL_REQUIRED_CHECK_MISSING',
  'IMAGE_KERNEL_REQUIRED_CHECK_DUPLICATE',
  'IMAGE_KERNEL_EMPTY_REQUIRED_CHECKS',
  'IMAGE_KERNEL_ACTION_CYCLE_MISMATCH',
  'IMAGE_KERNEL_READINESS_MISMATCH',
  'IMAGE_KERNEL_READINESS_POLICY_MISMATCH',
  'IMAGE_KERNEL_FACTS_EVALUATOR_MISMATCH',
  'IMAGE_KERNEL_FACT_CHECK_MISSING',
  'IMAGE_KERNEL_FACT_CHECK_UNKNOWN',
  'IMAGE_KERNEL_FACT_CHECK_DUPLICATE',
  'IMAGE_KERNEL_FACT_STATUS_UNKNOWN',
  'IMAGE_KERNEL_RASTER_AUTHORITY_UNUSABLE',
  'IMAGE_KERNEL_ORACLE_FACTS_ABSENT',
  'IMAGE_KERNEL_AUTHORITY_MALFORMED',
  'IMAGE_KERNEL_EVIDENCE_UNDECLARED',
  'IMAGE_KERNEL_EVIDENCE_DIAGNOSTIC_ONLY',
] as const;
export type ImageKernelIssueCode = (typeof IMAGE_KERNEL_ISSUE_CODES)[number];

export interface ImageKernelIssue {
  readonly code: ImageKernelIssueCode;
  readonly detail: string;
  readonly checkId: string | null;
}

export interface ImageKernelResult {
  readonly kind: ImageKernelKind;
  /**
   * `true` when the compiled profile was trustworthy and a complete check
   * result was produced for every declared check (possibly all `UNUSABLE`).
   * `false` when the profile itself failed validation; `checks` is then empty
   * because no trustworthy check may be fabricated from an invalid profile.
   */
  readonly ok: boolean;
  readonly checks: readonly CorrectnessCheckResult[];
  readonly issues: readonly ImageKernelIssue[];
}

export interface ImageKernelInput {
  readonly profile: ResolvedCorrectnessProfile;
  readonly route: ImageKernelRoute;
  readonly actionCycle: ActionCycleCorrectnessIdentity;
  readonly facts: ImageKernelFacts;
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
  code: ImageKernelIssueCode,
  detail: string,
  checkId: string | null = null,
): ImageKernelIssue {
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

function normalizeCadence(value: unknown): number[] | null {
  return Array.isArray(value) &&
    value.every((entry) => typeof entry === 'number' && Number.isFinite(entry))
    ? (value as number[])
    : null;
}

function sameCadence(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
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
 * Validates that the compiled profile is exactly the immutable Image profile for
 * the requested route and that the Action Cycle observed the same profile. Every
 * failure is fail-closed and reported as a structured issue; the fingerprint is
 * independently recomputed from the profile content so a mutated compiled field
 * is detected rather than trusted.
 */
function validateProfile(
  profile: ResolvedCorrectnessProfile,
  route: ImageKernelRoute,
  actionCycle: ActionCycleCorrectnessIdentity,
): ImageKernelIssue[] {
  const issues: ImageKernelIssue[] = [];
  if (!isPlainRecord(profile)) {
    issues.push(
      issue('IMAGE_KERNEL_PROFILE_NOT_OBJECT', 'The compiled profile is not a plain object.'),
    );
    return issues;
  }
  if (profile.schemaVersion !== RESOLVED_CORRECTNESS_PROFILE_SCHEMA_VERSION) {
    issues.push(
      issue(
        'IMAGE_KERNEL_PROFILE_SCHEMA_UNSUPPORTED',
        `Resolved-profile schema ${String(profile.schemaVersion)} is not supported.`,
      ),
    );
  }

  const storedFingerprint = profile.resolvedFingerprint;
  if (storedFingerprint === undefined || storedFingerprint === null) {
    issues.push(
      issue(
        'IMAGE_KERNEL_PROFILE_FINGERPRINT_MISSING',
        'The compiled profile carries no resolved fingerprint.',
      ),
    );
  } else if (!isFullCanonicalFingerprint(storedFingerprint)) {
    issues.push(
      issue(
        'IMAGE_KERNEL_PROFILE_FINGERPRINT_INVALID',
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
          'IMAGE_KERNEL_PROFILE_FINGERPRINT_MISMATCH',
          'The compiled resolved fingerprint does not match the profile content; a compiled field was mutated.',
        ),
      );
    }
  }

  const componentFingerprints = profile.componentFingerprints;
  if (!isPlainRecord(componentFingerprints)) {
    issues.push(
      issue(
        'IMAGE_KERNEL_COMPONENT_FINGERPRINT_INVALID',
        'The compiled profile carries no component fingerprints.',
      ),
    );
  } else {
    for (const field of COMPONENT_FINGERPRINT_FIELDS) {
      if (!isFullCanonicalFingerprint(componentFingerprints[field])) {
        issues.push(
          issue(
            'IMAGE_KERNEL_COMPONENT_FINGERPRINT_INVALID',
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
        'IMAGE_KERNEL_ROUTE_MISMATCH',
        `Compiled profile route ${profile.subjectId}×${String(profile.capability)}@${profile.variant ?? '∅'} does not equal the requested route ${route.subjectId}×${String(route.capability)}@${route.variant ?? '∅'}.`,
      ),
    );
  }

  const oracle: unknown = profile.oracle;
  if (!isPlainRecord(oracle) || oracle.evaluatorKind !== IMAGE_KERNEL_EVALUATOR) {
    const found = isPlainRecord(oracle) ? String(oracle.evaluatorKind) : 'undefined';
    issues.push(
      issue(
        'IMAGE_KERNEL_ORACLE_EVALUATOR_UNSUPPORTED',
        `Compiled Oracle evaluator "${found}" is not supported by this Image kernel (expected "${IMAGE_KERNEL_EVALUATOR}").`,
      ),
    );
  }

  const requiredChecks = Array.isArray(profile.requiredChecks) ? profile.requiredChecks : [];
  if (requiredChecks.length === 0) {
    issues.push(
      issue(
        'IMAGE_KERNEL_EMPTY_REQUIRED_CHECKS',
        'A compiled profile with no declared required check cannot produce a check result.',
      ),
    );
  }
  const seen = new Set<string>();
  for (const check of requiredChecks) {
    const checkId = typeof check.checkId === 'string' ? check.checkId : null;
    if (checkId === null) {
      issues.push(
        issue('IMAGE_KERNEL_REQUIRED_CHECK_MISSING', 'A declared required check has no check id.'),
      );
      continue;
    }
    if (seen.has(checkId)) {
      issues.push(
        issue(
          'IMAGE_KERNEL_REQUIRED_CHECK_DUPLICATE',
          `Declared required check "${checkId}" appears more than once.`,
          checkId,
        ),
      );
      continue;
    }
    seen.add(checkId);
    if (
      typeof check.evaluator !== 'string' ||
      !(IMAGE_KERNEL_CHECK_EVALUATORS as readonly string[]).includes(check.evaluator)
    ) {
      issues.push(
        issue(
          'IMAGE_KERNEL_CHECK_EVALUATOR_UNSUPPORTED',
          `Required check "${checkId}" declares evaluator "${String(check.evaluator)}" which this Image kernel does not support.`,
          checkId,
        ),
      );
    }
  }

  if (actionCycle.resolvedProfileFingerprint !== storedFingerprint) {
    issues.push(
      issue(
        'IMAGE_KERNEL_ACTION_CYCLE_MISMATCH',
        'The Action Cycle resolved-profile fingerprint does not equal the compiled profile fingerprint.',
      ),
    );
  }
  if (actionCycle.readinessFingerprint !== profile.componentFingerprints?.readiness) {
    issues.push(
      issue(
        'IMAGE_KERNEL_READINESS_MISMATCH',
        'The Action Cycle readiness fingerprint does not equal the compiled readiness component.',
      ),
    );
  }
  return issues;
}

interface EvidenceConsumption {
  readonly consumed: readonly string[];
  readonly authoritative: boolean;
  readonly authorityState: ImageAuthorityState;
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
  facts: readonly ImageEvidenceFact[],
  issues: ImageKernelIssue[],
): EvidenceConsumption {
  const checkId = contract.checkId;
  const byId = new Map<string, ImageEvidenceFact>();
  for (const fact of facts) {
    if (isPlainRecord(fact) && typeof fact.evidenceId === 'string') {
      byId.set(fact.evidenceId, fact as unknown as ImageEvidenceFact);
    }
  }
  const globalDeclared = new Set(profile.requiredAuthoritativeEvidence);
  const consumed: string[] = [];
  let authorityState: ImageAuthorityState = 'current';

  for (const requiredId of sortStrings(contract.requiredEvidence)) {
    if (!globalDeclared.has(requiredId)) {
      issues.push(
        issue(
          'IMAGE_KERNEL_EVIDENCE_UNDECLARED',
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
          'IMAGE_KERNEL_EVIDENCE_DIAGNOSTIC_ONLY',
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
          'IMAGE_KERNEL_EVIDENCE_UNDECLARED',
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
 * Validates the accepted readiness policy against the compiled readiness
 * authority and maps the observed outcome to a kernel gate. The compiled policy
 * is the single authority: a runtime constant that disagrees with it is a
 * contract disagreement, not a permissible override.
 */
type ReadinessGate =
  | { readonly kind: 'continue' }
  | { readonly kind: 'fail'; readonly authority: ImageAuthorityState }
  | { readonly kind: 'unusable'; readonly authority: ImageAuthorityState; readonly detail: string };

function readReadinessGate(
  profile: ResolvedCorrectnessProfile,
  readiness: ImageReadinessFact,
  issues: ImageKernelIssue[],
): ReadinessGate {
  if (!isPlainRecord(readiness) || !isPlainRecord(readiness.policy)) {
    issues.push(
      issue(
        'IMAGE_KERNEL_READINESS_POLICY_MISMATCH',
        'The accepted Image facts carry no readiness policy projection.',
      ),
    );
    return {
      kind: 'unusable',
      authority: 'unavailable',
      detail: 'No readiness policy was accepted.',
    };
  }
  const policy = readiness.policy as ImageReadinessPolicyFact;
  const compiled = profile.readiness;
  const cadence = normalizeCadence(policy.fallbackCadenceMs);
  const disagreement =
    policy.profileId !== compiled.profileId ||
    policy.deadlineCategory !== compiled.deadlineCategory ||
    policy.deadlineMs !== compiled.deadlineMs ||
    policy.signalWatchdogMs !== compiled.signalWatchdogMs ||
    cadence === null ||
    !sameCadence(cadence, compiled.fallbackCadenceMs) ||
    policy.stableFrames !== compiled.stableFrames ||
    policy.quiescenceRequired !== compiled.quiescenceRequired ||
    policy.stableFrameRequired !== compiled.stableFrameRequired;
  if (disagreement) {
    issues.push(
      issue(
        'IMAGE_KERNEL_READINESS_POLICY_MISMATCH',
        `The accepted readiness policy (${String(policy.profileId)} ${String(policy.deadlineCategory)} ${String(policy.deadlineMs)}ms) does not equal the compiled readiness authority (${compiled.profileId} ${compiled.deadlineCategory} ${compiled.deadlineMs}ms).`,
      ),
    );
    return {
      kind: 'unusable',
      authority: 'unavailable',
      detail: 'The accepted readiness policy diverges from the compiled readiness authority.',
    };
  }

  const observation = isPlainRecord(readiness.observation)
    ? (readiness.observation as ImageReadinessObservationFact)
    : null;
  const outcome = observation === null ? null : observation.outcome;
  if (!isImageReadinessOutcome(outcome)) {
    issues.push(
      issue(
        'IMAGE_KERNEL_READINESS_POLICY_MISMATCH',
        `The accepted readiness outcome "${String(outcome)}" is not in the closed vocabulary.`,
      ),
    );
    return { kind: 'unusable', authority: 'missing', detail: 'No readiness outcome was accepted.' };
  }
  if (outcome === 'converged') return { kind: 'continue' };
  if (outcome === 'deadline-exceeded') {
    // A well-formed raster that never converged to the expected resource by the
    // one deadline is a trustworthy product non-convergence (`FAIL`), never a
    // harness failure.
    return { kind: 'fail', authority: 'current' };
  }
  if (outcome === 'unusable') {
    const accepted = observation as ImageReadinessObservationFact;
    const authority = (IMAGE_AUTHORITY_STATES as readonly string[]).includes(
      accepted.authority as string,
    )
      ? accepted.authority
      : 'unavailable';
    return {
      kind: 'unusable',
      authority,
      detail: accepted.detail ?? 'The accepted raster readiness authority is unusable.',
    };
  }
  return {
    kind: 'unusable',
    authority: 'missing',
    detail: 'Raster readiness was never attempted; no current raster authority exists.',
  };
}

interface RasterAuthority {
  readonly state: ImageAuthorityState;
  readonly record: ImageRasterRecordView | null;
  readonly detail: string;
}

/** True when the two internal raster capture anchors agree field-for-field. */
function imageCaptureAnchorsAgree(capture: ImageRasterRecordView['capture']): boolean {
  const started = capture?.started;
  const completed = capture?.completed;
  if (started === undefined || completed === undefined) return false;
  return (
    started.schemaVersion === completed.schemaVersion &&
    started.documentId === completed.documentId &&
    started.documentEpoch === completed.documentEpoch &&
    started.bridgeVersion === completed.bridgeVersion &&
    started.bridgeGeneration === completed.bridgeGeneration &&
    started.revision === completed.revision
  );
}

/**
 * Validates the accepted live raster record through the accepted structural
 * contract (raster schema v3 closed union). A malformed, tainted, unreadable,
 * ambiguous, torn, non-ready, non-image-arm, or wrong-target record is
 * `UNUSABLE` authority; only a ready `image-source-v2` record whose id and
 * renderer target id equal the accepted target is `current`.
 */
function readRasterAuthority(raster: unknown, targetId: string): RasterAuthority {
  if (raster === null || raster === undefined) {
    return {
      state: 'missing',
      record: null,
      detail: `No live raster record was accepted for "${targetId}".`,
    };
  }
  const validation = validateRasterRecord(raster);
  if (!validation.ok) {
    const code = validation.diagnostic?.code ?? 'RASTER_AUTHORITY_UNUSABLE';
    const state: ImageAuthorityState =
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
    return { state, record: null, detail: validation.detail };
  }
  if (!isPlainRecord(raster)) {
    return {
      state: 'malformed',
      record: null,
      detail: 'The accepted raster record is not an object.',
    };
  }
  const status = raster.status;
  if (status === 'pending') {
    return {
      state: 'stale',
      record: null,
      detail: `The accepted raster record for "${targetId}" is still pending; authority is not current.`,
    };
  }
  if (status !== 'ready') {
    return {
      state: 'unavailable',
      record: null,
      detail: `The accepted raster record for "${targetId}" reports status ${String(status)}; no current rendered authority exists.`,
    };
  }
  const accepted = readAcceptedRasterAuthority(raster);
  if (!accepted.ok || accepted.record === null) {
    return { state: 'unavailable', record: null, detail: accepted.detail };
  }
  if (accepted.record.authorityKind !== 'image-source-v2') {
    return {
      state: 'malformed',
      record: null,
      detail: `Raster target "${accepted.record.id}" does not publish the image-source-v2 authority arm.`,
    };
  }
  const record = accepted.record;
  if (record.id !== targetId) {
    return {
      state: 'wrong-target',
      record: null,
      detail: `Raster target id "${record.id}" does not equal "${targetId}".`,
    };
  }
  const capture = record.capture;
  if (capture.sourceStable !== true || capture.rendererStable !== true) {
    return {
      state: 'torn',
      record: null,
      detail: `Raster target "${targetId}" changed during acquisition; the record is torn.`,
    };
  }
  if (!imageCaptureAnchorsAgree(capture)) {
    return {
      state: 'torn',
      record: null,
      detail: `Raster target "${targetId}" internal capture start/end anchors do not agree; the record is torn.`,
    };
  }
  const rendererTargetId = record.renderer?.target?.id;
  if (rendererTargetId !== targetId) {
    return {
      state: 'wrong-target',
      record: null,
      detail: `Raster renderer target id "${String(rendererTargetId)}" does not equal "${targetId}".`,
    };
  }
  if (record.source === null || record.rendered === null) {
    return {
      state: 'unavailable',
      record: null,
      detail: 'A ready raster record must publish source and rendered authority.',
    };
  }
  return { state: 'current', record, detail: 'Raster authority is current.' };
}

/**
 * Validates the accepted Image check facts against the compiled required-check
 * set: a declared check may have exactly one boolean/unusable fact, and an
 * undeclared check fact is rejected without being consumed.
 */
function isWellFormedEvaluatorFact(value: unknown): value is ImageEvaluatorFact {
  if (!isPlainRecord(value)) return false;
  return (
    isImageAuthorityState(value.authority) &&
    isImageFactCurrentness(value.currentness) &&
    typeof value.sourcesAgree === 'boolean' &&
    typeof value.mismatch === 'boolean'
  );
}

function validateCheckFacts(
  profile: ResolvedCorrectnessProfile,
  facts: ImageKernelFacts,
  issues: ImageKernelIssue[],
): void {
  const declaredIds = new Set(profile.requiredChecks.map((entry) => entry.checkId));
  const seenFactIds = new Set<string>();
  let authorityMalformed = false;
  for (const entry of Array.isArray(facts.checks) ? facts.checks : []) {
    const fact = entry as unknown;
    if (!isPlainRecord(fact) || typeof fact.checkId !== 'string') {
      issues.push(
        issue('IMAGE_KERNEL_FACT_STATUS_UNKNOWN', 'An Image evaluator fact has no check id.'),
      );
      continue;
    }
    if (seenFactIds.has(fact.checkId)) {
      issues.push(
        issue(
          'IMAGE_KERNEL_FACT_CHECK_DUPLICATE',
          `Image evaluator fact "${fact.checkId}" appears more than once.`,
          fact.checkId,
        ),
      );
      continue;
    }
    seenFactIds.add(fact.checkId);
    if (!declaredIds.has(fact.checkId)) {
      issues.push(
        issue(
          'IMAGE_KERNEL_FACT_CHECK_UNKNOWN',
          `Image evaluator fact "${fact.checkId}" is not a declared required check.`,
          fact.checkId,
        ),
      );
    }
    if (!isWellFormedEvaluatorFact(fact)) {
      issues.push(
        issue(
          'IMAGE_KERNEL_FACT_STATUS_UNKNOWN',
          `Image evaluator fact "${fact.checkId}" carries no explicit structured authority/currentness/source-agreement/mismatch facts.`,
          fact.checkId,
        ),
      );
      continue;
    }
    if (fact.authority === 'malformed') authorityMalformed = true;
  }
  if (facts.oracleFacts === null) {
    issues.push(
      issue(
        'IMAGE_KERNEL_ORACLE_FACTS_ABSENT',
        'The accepted Image Oracle produced no facts; no required check can be trusted.',
      ),
    );
  }
  if (authorityMalformed) {
    issues.push(
      issue(
        'IMAGE_KERNEL_AUTHORITY_MALFORMED',
        'The accepted Image evaluator authority is malformed (unusable raster/source authority); no required check can be trusted.',
      ),
    );
  }
}

function expectedPayload(
  profile: ResolvedCorrectnessProfile,
  contract: ResolvedCheckContract,
  facts: ImageKernelFacts,
): Record<string, unknown> {
  const resource = facts.expectedResource;
  const accepted = facts.acceptedUpload;
  return {
    schema: contract.expectedSchema,
    evaluator: contract.evaluator,
    oracleProfileId: profile.oracle.oracleProfileId,
    checkId: contract.checkId,
    mode: facts.mode,
    targetId: facts.targetId,
    expectedLayoutId: facts.expectedLayoutId,
    expectedFrame: {
      x: numberOrNull(facts.expectedFrame?.x),
      y: numberOrNull(facts.expectedFrame?.y),
      width: numberOrNull(facts.expectedFrame?.width),
      height: numberOrNull(facts.expectedFrame?.height),
      rotation: numberOrNull(facts.expectedFrame?.rotation),
    },
    expectedResource: {
      logicalId: stringOrNull(resource?.logicalId),
      version: numberOrNull(resource?.version),
      sha256: stringOrNull(resource?.sha256),
      byteLength: numberOrNull(resource?.byteLength),
      mimeType: stringOrNull(resource?.mimeType),
      dimensions: {
        width: numberOrNull(resource?.dimensions?.width),
        height: numberOrNull(resource?.dimensions?.height),
      },
    },
    expectedProbes: Array.isArray(resource?.probes)
      ? resource.probes.map((probe) => ({
          id: stringOrNull(probe?.id),
          x: {
            numerator: numberOrNull(probe?.x?.numerator),
            denominator: numberOrNull(probe?.x?.denominator),
          },
          y: {
            numerator: numberOrNull(probe?.y?.numerator),
            denominator: numberOrNull(probe?.y?.denominator),
          },
          expectedRgba: Array.isArray(probe?.expectedRgba) ? [...probe.expectedRgba] : [],
          channelTolerance: numberOrNull(probe?.channelTolerance),
        }))
      : [],
    acceptedUpload:
      accepted === null
        ? null
        : {
            sourceSha256: stringOrNull(accepted.sourceSha256),
            rgbaSha256: stringOrNull(accepted.rgbaSha256),
          },
    // The compiled signal-first readiness policy the accepted cycle must obey.
    readinessPolicy: {
      profileId: profile.readiness.profileId,
      deadlineCategory: profile.readiness.deadlineCategory,
      deadlineMs: profile.readiness.deadlineMs,
      signalWatchdogMs: profile.readiness.signalWatchdogMs,
      fallbackCadenceMs: [...profile.readiness.fallbackCadenceMs],
      stableFrames: profile.readiness.stableFrames,
      quiescenceRequired: profile.readiness.quiescenceRequired,
      stableFrameRequired: profile.readiness.stableFrameRequired,
    },
    requiredEvidence: sortStrings(contract.requiredEvidence),
    toleranceRefs: sortStrings(contract.toleranceRefs),
    visualRefs: sortStrings(contract.visualRefs),
    normalizationRef: contract.normalizationRef,
  };
}

function actualPayload(
  profile: ResolvedCorrectnessProfile,
  contract: ResolvedCheckContract,
  facts: ImageKernelFacts,
  readiness: ReadinessGate,
  raster: RasterAuthority,
  fact: ImageEvaluatorFact | null,
  evidence: EvidenceConsumption,
  status: CheckResultStatus,
  authority: ImageAuthorityState,
): Record<string, unknown> {
  const observation = isPlainRecord(facts.readiness?.observation)
    ? (facts.readiness.observation as ImageReadinessObservationFact)
    : null;
  const record = raster.record;
  const source = record?.source ?? null;
  const rendered = record?.rendered ?? null;
  return {
    schema: contract.actualSchema,
    status,
    authority,
    currentness: fact === null ? null : fact.currentness,
    sourcesAgree: fact === null ? null : fact.sourcesAgree,
    mismatch: fact === null ? null : fact.mismatch,
    mode: facts.mode,
    targetId: facts.targetId,
    readiness: {
      profileId: profile.readiness.profileId,
      outcome: observation?.outcome ?? null,
      authority: observation?.authority ?? null,
      gate: readiness.kind,
      wakeSource: observation?.wakeSource ?? null,
      fallbackPollCount: numberOrNull(observation?.fallbackPollCount),
      watchdogWaits: numberOrNull(observation?.watchdogWaits),
      attempts: numberOrNull(observation?.attempts),
      tornCount: numberOrNull(observation?.tornCount),
      mismatches: Array.isArray(observation?.mismatches) ? [...observation.mismatches] : [],
      detail: observation?.detail ?? null,
    },
    rasterAuthority: raster.state,
    raster:
      record === null
        ? null
        : {
            schemaVersion: record.rasterSchemaVersion,
            authorityKind: record.authorityKind,
            id: record.id,
            status: record.status,
            rendererTargetId: stringOrNull(record.renderer?.target?.id),
          },
    source:
      source === null
        ? null
        : {
            scheme: source.scheme,
            sha256: source.sha256,
            byteLength: numberOrNull(source.byteLength),
            mimeType: source.mimeType,
            decodedWidth: numberOrNull(source.decodedWidth),
            decodedHeight: numberOrNull(source.decodedHeight),
            sourceFingerprint: stringOrNull(source.sourceFingerprint),
          },
    rendered:
      rendered === null
        ? null
        : {
            nodeClass: rendered.nodeClass,
            rgbaSha256: stringOrNull(rendered.rgbaSha256),
            rgbaByteLength: numberOrNull(rendered.rgbaByteLength),
            backingWidth: numberOrNull(rendered.backingWidth),
            backingHeight: numberOrNull(rendered.backingHeight),
            nonTransparentPixelCount: numberOrNull(rendered.nonTransparentPixelCount),
            drawnWidth: numberOrNull(rendered.drawnWidth),
            drawnHeight: numberOrNull(rendered.drawnHeight),
            probeIds: Array.isArray(rendered.probes)
              ? rendered.probes.map((probe) => stringOrNull(probe.probeId))
              : [],
          },
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
            checks: Array.isArray(facts.oracleFacts.checks)
              ? facts.oracleFacts.checks.map((entry) => ({
                  checkId: stringOrNull(entry?.checkId),
                  predicateMet: entry?.predicateMet === true,
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
 * A trustworthy product mismatch / non-convergence is `FAIL`; a missing,
 * stale, torn, wrong-target, malformed, or non-authoritative raster/source/blob
 * authority, an absent accepted fact, a non-authoritative required evidence
 * role, or a harness-invalid Action Cycle is `UNUSABLE`.
 */
function resolveStatus(
  readiness: ReadinessGate,
  raster: RasterAuthority,
  fact: ImageEvaluatorFact | null,
  evidence: EvidenceConsumption,
): { status: CheckResultStatus; authority: ImageAuthorityState } {
  if (readiness.kind === 'unusable') {
    return { status: 'UNUSABLE', authority: readiness.authority };
  }
  if (readiness.kind === 'fail') {
    // The accepted readiness loop reported a well-formed raster that never
    // converged to the expected resource by the one non-extending deadline.
    return { status: 'FAIL', authority: readiness.authority };
  }
  if (raster.state !== 'current') {
    return { status: 'UNUSABLE', authority: raster.state };
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

function runImageKernel(input: ImageKernelInput): ImageKernelResult {
  const { profile, route, actionCycle, facts } = input;
  const issues = validateProfile(profile, route, actionCycle);
  if (issues.length > 0) {
    return { kind: IMAGE_KERNEL_EVALUATOR, ok: false, checks: [], issues };
  }

  if (facts.evaluator !== IMAGE_KERNEL_EVALUATOR) {
    issues.push(
      issue(
        'IMAGE_KERNEL_FACTS_EVALUATOR_MISMATCH',
        `Image facts declare evaluator "${String(facts.evaluator)}" instead of "${IMAGE_KERNEL_EVALUATOR}".`,
      ),
    );
  }

  validateCheckFacts(profile, facts, issues);
  const readiness = readReadinessGate(profile, facts.readiness, issues);
  const raster = readRasterAuthority(facts.raster, facts.targetId);
  if (raster.state !== 'current' && readiness.kind === 'continue') {
    issues.push(
      issue(
        'IMAGE_KERNEL_RASTER_AUTHORITY_UNUSABLE',
        `The accepted live raster authority is ${raster.state}: ${raster.detail}`,
      ),
    );
  }

  const factById = new Map<string, ImageEvaluatorFact>();
  for (const entry of Array.isArray(facts.checks) ? facts.checks : []) {
    if (
      isPlainRecord(entry) &&
      typeof entry.checkId === 'string' &&
      isWellFormedEvaluatorFact(entry) &&
      !factById.has(entry.checkId)
    ) {
      factById.set(entry.checkId, entry);
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
    if (fact === null && readiness.kind === 'continue') {
      issues.push(
        issue(
          'IMAGE_KERNEL_FACT_CHECK_MISSING',
          `No accepted Image evaluator fact exists for declared check "${contract.checkId}".`,
          contract.checkId,
        ),
      );
    }
    const resolved = resolveStatus(readiness, raster, fact, evidence);
    checks.push(
      buildCheckResult(
        profile,
        actionCycle,
        contract,
        resolved.status,
        expectedPayload(profile, contract, facts),
        actualPayload(
          profile,
          contract,
          facts,
          readiness,
          raster,
          fact,
          evidence,
          resolved.status,
          resolved.authority,
        ),
        evidence.consumed,
      ),
    );
  }

  return { kind: IMAGE_KERNEL_EVALUATOR, ok: true, checks, issues };
}

/**
 * The Image upload/replacement final kernel. It evaluates the profile's
 * declared Image checks from the accepted Image Oracle, readiness, raster, and
 * evidence facts.
 */
export function evaluateImageChecks(input: ImageKernelInput): ImageKernelResult {
  return runImageKernel(input);
}

/** Runtimes dispatch to exactly one Image kernel kind. */
export function imageKernelKindForEvaluator(
  evaluatorKind: string | null | undefined,
): ImageKernelKind | null {
  return evaluatorKind === IMAGE_KERNEL_EVALUATOR ? IMAGE_KERNEL_EVALUATOR : null;
}
