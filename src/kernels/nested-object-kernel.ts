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
import { isPlainRecord } from '../contracts/result-agreement';
import {
  CHECK_RESULT_CONTRACT_SCHEMA_VERSION,
  RESOLVED_CORRECTNESS_PROFILE_SCHEMA_VERSION,
} from '../contracts/schema-versions';

/**
 * P7-B B1-C inactive final compiled-profile kernel for nested Object execution
 * (ADR 0028 §3 B1-C).
 *
 * A nested Object move is proven by the accepted `nested-object-affine` Oracle
 * (ADR 0013 R9/R10, ADR 0014, ADR 0027 §1.3/§1.4). That Oracle consumes one
 * accepted coherent baseline/observed pair of typed geometry-v3 records plus the
 * accepted canonical snapshots and resolves four required checks:
 *
 *  - `containment.parent-chain`  — the target/witness/Layout chain ids, order,
 *    and parentage are unchanged;
 *  - `geometry.local-invariant` — every descendant parent-local frame stays
 *    exact in ids, dims, **persisted rotation**, flips, content/style/warp,
 *    order, z, and parentage, and the plain Text witness keeps its exact
 *    four-sided render padding;
 *  - `geometry.world-composition` — canonical and live corresponding witness
 *    points agree before and after within the accepted render tolerance;
 *  - `geometry.delta` — the browser movement equals the unchanged linear
 *    projection of the actual canonical target delta, meets the minimum move,
 *    and all witness points share one rigid translation.
 *
 * This kernel is the *inactive final* consumer of those facts. It receives
 * exactly three things:
 *
 *  1. the immutable compiled `ResolvedCorrectnessProfile`;
 *  2. the Action Cycle correctness identity that observed the action; and
 *  3. the accepted structured `nested-object-affine` evaluator facts plus the
 *     observed evidence roles.
 *
 * It returns one complete, field-rich `CorrectnessCheckResult` per declared
 * required check — or, when the compiled profile itself is not trustworthy, no
 * fabricated checks at all.
 *
 * Every correctness input is read from the compiled profile. This module owns no
 * required-check list, no tolerance/visual/normalization literal, no minimum
 * delta, no evidence list, no fallback id, and no Subject-name/family/scenario
 * branch; it never reloads an authoring catalogue. The accepted nested meaning is
 * preserved exactly:
 *
 *  - a trustworthy in-band `parent-chain` / `local-invariant` /
 *    `world-composition` / `delta` mismatch is `FAIL`;
 *  - missing / stale / torn / ambiguous / malformed evidence, an absent accepted
 *    authority (`oracleFacts === null`), or a malformed structured authority
 *    (unreadable typed source or camera degeneracy) is `UNUSABLE`;
 *  - a diagnostic-only item can never rescue a required check.
 *
 * The legacy aggregate `harnessInvalid` flag, the legacy `requiredSourcesAgree`
 * aggregate, and the legacy per-check boolean `passed` are deliberately absent
 * from the fact contract: authority, currentness, source agreement, and product
 * mismatch are carried as separate structured facts so no boolean check result is
 * translated into a final status.
 *
 * The kernel is deliberately inactive. Nothing here is imported by the active
 * executor, Oracle, classifier, writer, or CLI, and no module under `src/runtime`
 * or `src/oracles` is imported in return: the structured fact contract below is
 * structurally satisfied by the delivered Oracle observations, so the atomic B2
 * cutover can pass them in without this module depending on active machinery.
 */

/** The single delivered nested-Object evaluator family this kernel owns. */
export const NESTED_OBJECT_KERNEL_KINDS = ['nested-object-affine'] as const;
export type NestedObjectKernelKind = (typeof NESTED_OBJECT_KERNEL_KINDS)[number];

/** The compiled Oracle/check discriminant the nested Object route resolves. */
export const NESTED_OBJECT_KERNEL_EVALUATOR = 'nested-object-affine';

/**
 * Closed evidence-availability vocabulary. Only `authoritative` evidence is
 * current and interpretable; every other state makes a required check
 * `UNUSABLE`. `diagnostic-only` is the single role that must never satisfy a
 * required check.
 */
export const NESTED_OBJECT_EVIDENCE_AVAILABILITY = [
  'authoritative',
  'ambiguous',
  'diagnostic-only',
  'malformed',
  'missing',
  'stale',
  'torn',
] as const;
export type NestedObjectEvidenceAvailability = (typeof NESTED_OBJECT_EVIDENCE_AVAILABILITY)[number];

export function isNestedObjectEvidenceAvailability(
  value: unknown,
): value is NestedObjectEvidenceAvailability {
  return (
    typeof value === 'string' &&
    (NESTED_OBJECT_EVIDENCE_AVAILABILITY as readonly string[]).includes(value)
  );
}

/** One accepted evidence fact the runtime actually observed for a check. */
export interface NestedObjectEvidenceFact {
  readonly evidenceId: string;
  readonly availability: NestedObjectEvidenceAvailability;
}

/** A finite `{ x, y }` vector, structurally identical to the accepted geometry points. */
export interface NestedObjectKernelVector {
  readonly x: number;
  readonly y: number;
}

/** One per-check point delta from the accepted nested movement facts. */
export interface NestedObjectPointDeltaFact {
  readonly point: string;
  readonly x: number;
  readonly y: number;
}

/** The exact four-sided render padding of one frame, or `null`. */
export interface NestedObjectPaddingFact {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
}

/** The persisted semantic frame of one canonical chain segment. */
export interface NestedObjectPersistedFrameFact {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly rotationDegrees: number;
  readonly flipX: boolean;
  readonly flipY: boolean;
}

/** The renderer frame of one canonical chain segment (with required padding). */
export interface NestedObjectRenderFrameFact {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly rotationDegrees: number;
  readonly derivation: string;
  readonly padding: NestedObjectPaddingFact | null;
  readonly frameShift: NestedObjectKernelVector;
}

/** One canonical chain segment with its before/after persisted and render frames. */
export interface NestedObjectSegmentFact {
  readonly segmentId: string;
  readonly kind: string;
  readonly persistedBefore: NestedObjectPersistedFrameFact;
  readonly persistedAfter: NestedObjectPersistedFrameFact;
  readonly renderBefore: NestedObjectRenderFrameFact;
  readonly renderAfter: NestedObjectRenderFrameFact;
}

/** The chain representation identity of the accepted baseline projection. */
export interface NestedObjectRepresentationFact {
  readonly kind: string;
  readonly representationVersion: number;
  readonly chainFingerprint: string;
  readonly representationFingerprint: string;
  readonly pointOrder: readonly string[];
}

/** The accepted product normalization certificate before/after capture. */
export interface NestedObjectFixtureNormalizationFact {
  readonly certificateVersion: string;
  readonly fixedPointBefore: boolean;
  readonly fixedPointAfter: boolean;
  readonly baselineSubtreeFingerprint: string;
  readonly observedSubtreeFingerprint: string;
}

/** The wrapper identities of the accepted target transform decomposition. */
export interface NestedObjectWrappersFact {
  readonly translationWrapperFingerprint: string;
  readonly centerRotationWrapperFingerprint: string;
  readonly completeMatrixFingerprint: string;
  readonly flipShellIdentity: boolean;
  readonly wrapperStructureValidated: boolean;
}

/** The canonical/live corresponding-point composition residuals. */
export interface NestedObjectCompositionFact {
  readonly correspondingPointOrder: readonly string[];
  readonly maxBaselineResidualCss: number;
  readonly maxObservedResidualCss: number;
  readonly toleranceCss: number;
}

/** The accepted nested movement projection. */
export interface NestedObjectMovementFact {
  readonly canonicalRootDeltaLayout: NestedObjectKernelVector;
  readonly expectedBrowserDeltaCss: NestedObjectKernelVector;
  readonly observedBrowserDeltaCssByPoint: readonly NestedObjectPointDeltaFact[];
  readonly rigidTranslation: boolean;
  readonly minimumSatisfied: boolean;
}

/**
 * The purpose-scoped interaction shape of one accepted geometry record. Only the
 * phase/purpose/authority contract is consumed; post-action hit status,
 * classification, obstruction, and candidate are deliberately absent so no
 * post-action hit authority can reach a result.
 */
export interface NestedObjectInteractionAuthorityFact {
  readonly phase: string;
  readonly purpose: string;
  readonly authority: string;
}

/** The accepted baseline/observed interaction authority shapes. */
export interface NestedObjectInteractionPairFact {
  readonly baseline: NestedObjectInteractionAuthorityFact;
  readonly observed: NestedObjectInteractionAuthorityFact;
}

/**
 * The bounded public nested-object geometry projection
 * (`NestedObjectPublicProjection`), structurally compatible with the delivered
 * Oracle fact.
 */
export interface NestedObjectGeometryProjectionFact {
  readonly representation: NestedObjectRepresentationFact;
  readonly fixtureNormalization: NestedObjectFixtureNormalizationFact;
  readonly frames: readonly NestedObjectSegmentFact[];
  readonly wrappers: NestedObjectWrappersFact;
  readonly composition: NestedObjectCompositionFact;
  readonly movement: NestedObjectMovementFact;
  readonly interaction: NestedObjectInteractionPairFact;
}

/**
 * The accepted `NestedObjectOracleFacts` projection the kernel evaluates.
 * Every field is the delivered Oracle's own fact.
 */
export interface NestedObjectOracleFactsView {
  readonly targetId: string;
  readonly witnessId: string;
  readonly layoutId: string;
  readonly parentChain: readonly string[];
  readonly requestedPointerDeltaCss: NestedObjectKernelVector;
  readonly canonicalTargetDelta: NestedObjectKernelVector;
  readonly expectedBrowserDeltaCss: NestedObjectKernelVector;
  readonly observedBrowserDeltaCss: readonly NestedObjectPointDeltaFact[];
  readonly localInvariant: boolean;
  readonly chainInvariant: boolean;
  readonly worldComposition: boolean;
  readonly cameraAgreement: boolean;
  readonly objectGeometry: NestedObjectGeometryProjectionFact;
}

/**
 * One accepted per-check nested-Object evaluator fact in explicit structured
 * form (ADR 0029 §4 B2-B). The legacy boolean `passed` is replaced by
 * structured authority, currentness, source-agreement, and product-mismatch
 * facts so the kernel maps them to a status from explicit structure instead of
 * translating a boolean check result.
 */
export interface NestedObjectEvaluatorFact {
  readonly checkId: string;
  /** Structured authority state of the accepted evaluator fact. */
  readonly authority: NestedObjectAuthorityState;
  /** Structured currentness of the accepted evaluator fact. */
  readonly currentness: NestedObjectFactCurrentness;
  /** Whether the independent canonical/live sources agreed. */
  readonly sourcesAgree: boolean;
  /** A trustworthy product mismatch under a current authority. */
  readonly mismatch: boolean;
}

/**
 * Accepted nested-Object evaluator facts plus the observed evidence roles.
 *
 * The legacy aggregate `harnessInvalid` flag, the legacy `requiredSourcesAgree`
 * aggregate, and the legacy per-check `passed` boolean are deliberately absent:
 * `checks` carries the explicit structured authority/currentness/
 * source-agreement/mismatch facts for every declared check, and `oracleFacts`
 * carries the accepted Oracle's raw persisted rotation/padding/delta/composition
 * primitive projection. The facts are supplied by the inactive live-fact
 * adapter from the delivered Oracle observations; this module owns no predicate
 * policy of its own.
 */
export interface NestedObjectKernelFacts {
  readonly evaluator: typeof NESTED_OBJECT_KERNEL_EVALUATOR;
  /** The Case Intent's accepted minimum delta, or `null` when it is unusable. */
  readonly minimumDelta: NestedObjectKernelVector | null;
  readonly checks: readonly NestedObjectEvaluatorFact[];
  /** The accepted Oracle facts, or `null` when the Oracle produced none. */
  readonly oracleFacts: NestedObjectOracleFactsView | null;
  readonly evidence: readonly NestedObjectEvidenceFact[];
}

/** The route a kernel is asked to evaluate. Passed in; never selected internally. */
export interface NestedObjectKernelRoute {
  readonly subjectId: string;
  readonly capability: Capability;
  readonly variant: string | null;
}

/** Closed authority state recorded in every `actual` interpretation. */
export const NESTED_OBJECT_AUTHORITY_STATES = [
  'ambiguous',
  'current',
  'malformed',
  'missing',
  'stale',
  'torn',
  'unavailable',
] as const;
export type NestedObjectAuthorityState = (typeof NESTED_OBJECT_AUTHORITY_STATES)[number];

/**
 * Closed structured currentness vocabulary for one accepted evaluator fact
 * (ADR 0029 §4 B2-B). Currentness is an explicit structured fact recorded per
 * check; it is never a final result status.
 */
export const NESTED_OBJECT_FACT_CURRENTNESS = ['current', 'stale', 'torn', 'unavailable'] as const;
export type NestedObjectFactCurrentness = (typeof NESTED_OBJECT_FACT_CURRENTNESS)[number];

export function isNestedObjectFactCurrentness(
  value: unknown,
): value is NestedObjectFactCurrentness {
  return (
    typeof value === 'string' &&
    (NESTED_OBJECT_FACT_CURRENTNESS as readonly string[]).includes(value)
  );
}

/** Projects a structured authority state onto the closed currentness domain. */
export function nestedObjectCurrentnessForAuthority(
  authority: NestedObjectAuthorityState,
): NestedObjectFactCurrentness {
  if (authority === 'current') return 'current';
  if (authority === 'stale') return 'stale';
  if (authority === 'torn') return 'torn';
  return 'unavailable';
}

function isNestedObjectAuthorityState(value: unknown): value is NestedObjectAuthorityState {
  return (
    typeof value === 'string' &&
    (NESTED_OBJECT_AUTHORITY_STATES as readonly string[]).includes(value)
  );
}

/** Closed kernel issue vocabulary; deliberately local to the inactive kernel. */
export const NESTED_OBJECT_KERNEL_ISSUE_CODES = [
  'NESTED_OBJECT_KERNEL_PROFILE_NOT_OBJECT',
  'NESTED_OBJECT_KERNEL_PROFILE_SCHEMA_UNSUPPORTED',
  'NESTED_OBJECT_KERNEL_PROFILE_FINGERPRINT_MISSING',
  'NESTED_OBJECT_KERNEL_PROFILE_FINGERPRINT_INVALID',
  'NESTED_OBJECT_KERNEL_PROFILE_FINGERPRINT_MISMATCH',
  'NESTED_OBJECT_KERNEL_COMPONENT_FINGERPRINT_INVALID',
  'NESTED_OBJECT_KERNEL_ROUTE_MISMATCH',
  'NESTED_OBJECT_KERNEL_ORACLE_EVALUATOR_UNSUPPORTED',
  'NESTED_OBJECT_KERNEL_CHECK_EVALUATOR_UNSUPPORTED',
  'NESTED_OBJECT_KERNEL_REQUIRED_CHECK_MISSING',
  'NESTED_OBJECT_KERNEL_REQUIRED_CHECK_DUPLICATE',
  'NESTED_OBJECT_KERNEL_EMPTY_REQUIRED_CHECKS',
  'NESTED_OBJECT_KERNEL_ACTION_CYCLE_MISMATCH',
  'NESTED_OBJECT_KERNEL_READINESS_MISMATCH',
  'NESTED_OBJECT_KERNEL_FACTS_EVALUATOR_MISMATCH',
  'NESTED_OBJECT_KERNEL_FACT_CHECK_MISSING',
  'NESTED_OBJECT_KERNEL_FACT_CHECK_UNKNOWN',
  'NESTED_OBJECT_KERNEL_FACT_CHECK_DUPLICATE',
  'NESTED_OBJECT_KERNEL_FACT_STATUS_UNKNOWN',
  'NESTED_OBJECT_KERNEL_ORACLE_FACTS_ABSENT',
  'NESTED_OBJECT_KERNEL_AUTHORITY_MALFORMED',
  'NESTED_OBJECT_KERNEL_EVIDENCE_UNDECLARED',
  'NESTED_OBJECT_KERNEL_EVIDENCE_DIAGNOSTIC_ONLY',
] as const;
export type NestedObjectKernelIssueCode = (typeof NESTED_OBJECT_KERNEL_ISSUE_CODES)[number];

export interface NestedObjectKernelIssue {
  readonly code: NestedObjectKernelIssueCode;
  readonly detail: string;
  readonly checkId: string | null;
}

export interface NestedObjectKernelResult {
  readonly kind: NestedObjectKernelKind;
  /**
   * `true` when the compiled profile was trustworthy and a complete check
   * result was produced for every declared check (possibly all `UNUSABLE`).
   * `false` when the profile itself failed validation; `checks` is then empty
   * because no trustworthy check may be fabricated from an invalid profile.
   */
  readonly ok: boolean;
  readonly checks: readonly CorrectnessCheckResult[];
  readonly issues: readonly NestedObjectKernelIssue[];
}

export interface NestedObjectKernelInput {
  readonly profile: ResolvedCorrectnessProfile;
  readonly route: NestedObjectKernelRoute;
  readonly actionCycle: ActionCycleCorrectnessIdentity;
  readonly facts: NestedObjectKernelFacts;
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
  code: NestedObjectKernelIssueCode,
  detail: string,
  checkId: string | null = null,
): NestedObjectKernelIssue {
  return { code, detail, checkId };
}

function sortStrings(values: readonly string[]): string[] {
  return [...values].sort();
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function boolOrFalse(value: unknown): boolean {
  return value === true;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

function vectorPayload(value: unknown): { x: number | null; y: number | null } | null {
  if (!isPlainRecord(value)) return null;
  return { x: numberOrNull(value.x), y: numberOrNull(value.y) };
}

function paddingPayload(value: unknown): Record<string, unknown> | null {
  if (!isPlainRecord(value)) return null;
  return {
    left: numberOrNull(value.left),
    right: numberOrNull(value.right),
    top: numberOrNull(value.top),
    bottom: numberOrNull(value.bottom),
  };
}

function persistedFramePayload(value: unknown): Record<string, unknown> {
  const frame = isPlainRecord(value) ? value : {};
  return {
    x: numberOrNull(frame.x),
    y: numberOrNull(frame.y),
    width: numberOrNull(frame.width),
    height: numberOrNull(frame.height),
    rotationDegrees: numberOrNull(frame.rotationDegrees),
    flipX: boolOrFalse(frame.flipX),
    flipY: boolOrFalse(frame.flipY),
  };
}

function renderFramePayload(value: unknown): Record<string, unknown> {
  const frame = isPlainRecord(value) ? value : {};
  const shift = isPlainRecord(frame.frameShift) ? frame.frameShift : {};
  return {
    x: numberOrNull(frame.x),
    y: numberOrNull(frame.y),
    width: numberOrNull(frame.width),
    height: numberOrNull(frame.height),
    rotationDegrees: numberOrNull(frame.rotationDegrees),
    derivation: stringOrNull(frame.derivation),
    padding: paddingPayload(frame.padding),
    frameShift: { x: numberOrNull(shift.x), y: numberOrNull(shift.y) },
  };
}

function segmentFramesPayload(
  projection: Record<string, unknown> | null,
  side: 'after' | 'before',
): Record<string, unknown>[] {
  const frames = projection === null || !Array.isArray(projection.frames) ? [] : projection.frames;
  const out: Record<string, unknown>[] = [];
  for (const entry of frames) {
    if (!isPlainRecord(entry)) continue;
    out.push({
      segmentId: stringOrNull(entry.segmentId),
      kind: stringOrNull(entry.kind),
      persistedFrame: persistedFramePayload(
        side === 'before' ? entry.persistedBefore : entry.persistedAfter,
      ),
      renderFrame: renderFramePayload(side === 'before' ? entry.renderBefore : entry.renderAfter),
    });
  }
  return out;
}

function observedDeltaPayload(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  const out: Record<string, unknown>[] = [];
  for (const entry of value) {
    if (!isPlainRecord(entry)) continue;
    out.push({
      point: stringOrNull(entry.point),
      x: numberOrNull(entry.x),
      y: numberOrNull(entry.y),
    });
  }
  return out;
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
 * Validates that the compiled profile is exactly the immutable nested-Object
 * profile for the requested route and that the Action Cycle observed the same
 * profile. Every failure is fail-closed and reported as a structured issue; the
 * fingerprint is independently recomputed from the profile content so a mutated
 * compiled field is detected rather than trusted.
 */
function validateProfile(
  profile: ResolvedCorrectnessProfile,
  route: NestedObjectKernelRoute,
  actionCycle: ActionCycleCorrectnessIdentity,
): NestedObjectKernelIssue[] {
  const issues: NestedObjectKernelIssue[] = [];
  if (!isPlainRecord(profile)) {
    issues.push(
      issue(
        'NESTED_OBJECT_KERNEL_PROFILE_NOT_OBJECT',
        'The compiled profile is not a plain object.',
      ),
    );
    return issues;
  }
  if (profile.schemaVersion !== RESOLVED_CORRECTNESS_PROFILE_SCHEMA_VERSION) {
    issues.push(
      issue(
        'NESTED_OBJECT_KERNEL_PROFILE_SCHEMA_UNSUPPORTED',
        `Resolved-profile schema ${String(profile.schemaVersion)} is not supported.`,
      ),
    );
  }

  const storedFingerprint = profile.resolvedFingerprint;
  if (storedFingerprint === undefined || storedFingerprint === null) {
    issues.push(
      issue(
        'NESTED_OBJECT_KERNEL_PROFILE_FINGERPRINT_MISSING',
        'The compiled profile carries no resolved fingerprint.',
      ),
    );
  } else if (!isFullCanonicalFingerprint(storedFingerprint)) {
    issues.push(
      issue(
        'NESTED_OBJECT_KERNEL_PROFILE_FINGERPRINT_INVALID',
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
          'NESTED_OBJECT_KERNEL_PROFILE_FINGERPRINT_MISMATCH',
          'The compiled resolved fingerprint does not match the profile content; a compiled field was mutated.',
        ),
      );
    }
  }

  const componentFingerprints = profile.componentFingerprints;
  if (!isPlainRecord(componentFingerprints)) {
    issues.push(
      issue(
        'NESTED_OBJECT_KERNEL_COMPONENT_FINGERPRINT_INVALID',
        'The compiled profile carries no component fingerprints.',
      ),
    );
  } else {
    for (const field of COMPONENT_FINGERPRINT_FIELDS) {
      if (!isFullCanonicalFingerprint(componentFingerprints[field])) {
        issues.push(
          issue(
            'NESTED_OBJECT_KERNEL_COMPONENT_FINGERPRINT_INVALID',
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
        'NESTED_OBJECT_KERNEL_ROUTE_MISMATCH',
        `Compiled profile route ${profile.subjectId}×${String(profile.capability)}@${profile.variant ?? '∅'} does not equal the requested route ${route.subjectId}×${String(route.capability)}@${route.variant ?? '∅'}.`,
      ),
    );
  }

  const oracle: unknown = profile.oracle;
  if (!isPlainRecord(oracle) || oracle.evaluatorKind !== NESTED_OBJECT_KERNEL_EVALUATOR) {
    const found = isPlainRecord(oracle) ? String(oracle.evaluatorKind) : 'undefined';
    issues.push(
      issue(
        'NESTED_OBJECT_KERNEL_ORACLE_EVALUATOR_UNSUPPORTED',
        `Compiled Oracle evaluator "${found}" is not supported by this nested-Object kernel (expected "${NESTED_OBJECT_KERNEL_EVALUATOR}").`,
      ),
    );
  }

  const requiredChecks = Array.isArray(profile.requiredChecks) ? profile.requiredChecks : [];
  if (requiredChecks.length === 0) {
    issues.push(
      issue(
        'NESTED_OBJECT_KERNEL_EMPTY_REQUIRED_CHECKS',
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
          'NESTED_OBJECT_KERNEL_REQUIRED_CHECK_MISSING',
          'A declared required check has no check id.',
        ),
      );
      continue;
    }
    if (seen.has(checkId)) {
      issues.push(
        issue(
          'NESTED_OBJECT_KERNEL_REQUIRED_CHECK_DUPLICATE',
          `Declared required check "${checkId}" appears more than once.`,
          checkId,
        ),
      );
      continue;
    }
    seen.add(checkId);
    if (check.evaluator !== NESTED_OBJECT_KERNEL_EVALUATOR) {
      issues.push(
        issue(
          'NESTED_OBJECT_KERNEL_CHECK_EVALUATOR_UNSUPPORTED',
          `Required check "${checkId}" declares evaluator "${String(check.evaluator)}" which this nested-Object kernel does not support.`,
          checkId,
        ),
      );
    }
  }

  if (actionCycle.resolvedProfileFingerprint !== storedFingerprint) {
    issues.push(
      issue(
        'NESTED_OBJECT_KERNEL_ACTION_CYCLE_MISMATCH',
        'The Action Cycle resolved-profile fingerprint does not equal the compiled profile fingerprint.',
      ),
    );
  }
  if (actionCycle.readinessFingerprint !== profile.componentFingerprints?.readiness) {
    issues.push(
      issue(
        'NESTED_OBJECT_KERNEL_READINESS_MISMATCH',
        'The Action Cycle readiness fingerprint does not equal the compiled readiness component.',
      ),
    );
  }
  return issues;
}

interface EvidenceConsumption {
  readonly consumed: readonly string[];
  readonly authoritative: boolean;
  readonly authorityState: NestedObjectAuthorityState;
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
  facts: readonly NestedObjectEvidenceFact[],
  issues: NestedObjectKernelIssue[],
): EvidenceConsumption {
  const checkId = contract.checkId;
  const byId = new Map<string, NestedObjectEvidenceFact>();
  for (const fact of facts) {
    if (isPlainRecord(fact) && typeof fact.evidenceId === 'string') {
      byId.set(fact.evidenceId, fact as unknown as NestedObjectEvidenceFact);
    }
  }
  const globalDeclared = new Set(profile.requiredAuthoritativeEvidence);
  const consumed: string[] = [];
  let authorityState: NestedObjectAuthorityState = 'current';

  for (const requiredId of sortStrings(contract.requiredEvidence)) {
    if (!globalDeclared.has(requiredId)) {
      issues.push(
        issue(
          'NESTED_OBJECT_KERNEL_EVIDENCE_UNDECLARED',
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
          'NESTED_OBJECT_KERNEL_EVIDENCE_DIAGNOSTIC_ONLY',
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
          'NESTED_OBJECT_KERNEL_EVIDENCE_UNDECLARED',
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
 * closed values and the source-agreement/mismatch facts are explicit booleans.
 * A fact that is not well formed is reported and can never be read as current.
 */
function isWellFormedEvaluatorFact(value: unknown): value is NestedObjectEvaluatorFact {
  if (!isPlainRecord(value)) return false;
  return (
    isNestedObjectAuthorityState(value.authority) &&
    isNestedObjectFactCurrentness(value.currentness) &&
    typeof value.sourcesAgree === 'boolean' &&
    typeof value.mismatch === 'boolean'
  );
}

function factAuthority(
  fact: NestedObjectEvaluatorFact | null,
  evidence: EvidenceConsumption,
  oracleAbsent: boolean,
): NestedObjectAuthorityState {
  if (fact === null) return 'missing';
  if (oracleAbsent && fact.authority !== 'malformed') return 'missing';
  return evidence.authoritative ? fact.authority : evidence.authorityState;
}

/**
 * The exact trust mapping. Only a current structured fact with authoritative
 * required evidence and a present accepted Oracle fact can be PASS or FAIL; a
 * trustworthy in-band mismatch under current authority is `FAIL`, and an absent
 * accepted authority, a malformed authority (unreadable typed source or camera
 * degeneracy), a missing check fact, or non-authoritative required evidence is
 * `UNUSABLE`. No boolean check result is translated into a status.
 */
function resolveStructuredStatus(
  fact: NestedObjectEvaluatorFact | null,
  evidenceAuthoritative: boolean,
): CheckResultStatus {
  if (fact === null || fact.authority !== 'current' || !evidenceAuthoritative) {
    return 'UNUSABLE';
  }
  return fact.mismatch ? 'FAIL' : 'PASS';
}

function oracleView(facts: NestedObjectKernelFacts): Record<string, unknown> | null {
  const accepted = facts.oracleFacts;
  if (accepted === null || !isPlainRecord(accepted)) return null;
  return accepted as unknown as Record<string, unknown>;
}

function projectionView(facts: NestedObjectKernelFacts): Record<string, unknown> | null {
  const accepted = oracleView(facts);
  return accepted !== null && isPlainRecord(accepted.objectGeometry)
    ? accepted.objectGeometry
    : null;
}

function nested(
  record: Record<string, unknown> | null,
  key: string,
): Record<string, unknown> | null {
  if (record === null || !isPlainRecord(record[key])) return null;
  return record[key] as Record<string, unknown>;
}

function expectedPayload(
  profile: ResolvedCorrectnessProfile,
  contract: ResolvedCheckContract,
  facts: NestedObjectKernelFacts,
): Record<string, unknown> {
  const accepted = oracleView(facts);
  const projection = projectionView(facts);
  const representation = nested(projection, 'representation');
  const normalization = nested(projection, 'fixtureNormalization');
  return {
    schema: contract.expectedSchema,
    evaluator: contract.evaluator,
    oracleProfileId: profile.oracle.oracleProfileId,
    checkId: contract.checkId,
    targetId: accepted === null ? null : stringOrNull(accepted.targetId),
    witnessId: accepted === null ? null : stringOrNull(accepted.witnessId),
    layoutId: accepted === null ? null : stringOrNull(accepted.layoutId),
    parentChain: accepted === null ? [] : stringList(accepted.parentChain),
    minimumDelta: vectorPayload(facts.minimumDelta),
    requestedPointerDeltaCss:
      accepted === null ? null : vectorPayload(accepted.requestedPointerDeltaCss),
    representationKind: representation === null ? null : stringOrNull(representation.kind),
    representationVersion:
      representation === null ? null : numberOrNull(representation.representationVersion),
    chainFingerprint:
      representation === null ? null : stringOrNull(representation.chainFingerprint),
    representationFingerprint:
      representation === null ? null : stringOrNull(representation.representationFingerprint),
    pointOrder: representation === null ? [] : stringList(representation.pointOrder),
    fixedPointBefore: normalization === null ? false : boolOrFalse(normalization.fixedPointBefore),
    baselineSubtreeFingerprint:
      normalization === null ? null : stringOrNull(normalization.baselineSubtreeFingerprint),
    // The baseline persisted/render frames are the invariant the accepted move
    // must preserve exactly (rotation, dims, flips, and four-sided padding).
    persistedFrames: segmentFramesPayload(projection, 'before'),
    renderFrames: segmentFramesPayload(projection, 'before'),
    requiredEvidence: sortStrings(contract.requiredEvidence),
    toleranceRefs: sortStrings(contract.toleranceRefs),
    visualRefs: sortStrings(contract.visualRefs),
    normalizationRef: contract.normalizationRef,
  };
}

function actualPayload(
  contract: ResolvedCheckContract,
  facts: NestedObjectKernelFacts,
  evidence: EvidenceConsumption,
  fact: NestedObjectEvaluatorFact | null,
): Record<string, unknown> {
  const accepted = oracleView(facts);
  const projection = projectionView(facts);
  const representation = nested(projection, 'representation');
  const normalization = nested(projection, 'fixtureNormalization');
  const wrappers = nested(projection, 'wrappers');
  const composition = nested(projection, 'composition');
  const movement = nested(projection, 'movement');
  const interaction = nested(projection, 'interaction');
  const baselineInteraction = nested(interaction, 'baseline');
  const observedInteraction = nested(interaction, 'observed');
  return {
    schema: contract.actualSchema,
    authority: factAuthority(fact, evidence, accepted === null),
    currentness: fact === null ? 'unavailable' : fact.currentness,
    mismatch: fact?.mismatch ?? false,
    sourcesAgree: fact?.sourcesAgree ?? false,
    cameraAgreement: accepted === null ? false : boolOrFalse(accepted.cameraAgreement),
    chainInvariant: accepted === null ? false : boolOrFalse(accepted.chainInvariant),
    localInvariant: accepted === null ? false : boolOrFalse(accepted.localInvariant),
    worldComposition: accepted === null ? false : boolOrFalse(accepted.worldComposition),
    canonicalTargetDelta: accepted === null ? null : vectorPayload(accepted.canonicalTargetDelta),
    expectedBrowserDeltaCss:
      accepted === null ? null : vectorPayload(accepted.expectedBrowserDeltaCss),
    observedBrowserDeltaCssByPoint:
      accepted === null ? [] : observedDeltaPayload(accepted.observedBrowserDeltaCss),
    rigidTranslation: movement === null ? false : boolOrFalse(movement.rigidTranslation),
    minimumSatisfied: movement === null ? false : boolOrFalse(movement.minimumSatisfied),
    correspondingPointOrder:
      composition === null ? [] : stringList(composition.correspondingPointOrder),
    maxBaselineResidualCss:
      composition === null ? null : numberOrNull(composition.maxBaselineResidualCss),
    maxObservedResidualCss:
      composition === null ? null : numberOrNull(composition.maxObservedResidualCss),
    toleranceCss: composition === null ? null : numberOrNull(composition.toleranceCss),
    // The observed persisted/render frames expose the exact rotation and
    // four-sided padding facts the accepted invariant compared.
    persistedFrames: segmentFramesPayload(projection, 'after'),
    renderFrames: segmentFramesPayload(projection, 'after'),
    representationFingerprint:
      representation === null ? null : stringOrNull(representation.representationFingerprint),
    fixedPointAfter: normalization === null ? false : boolOrFalse(normalization.fixedPointAfter),
    observedSubtreeFingerprint:
      normalization === null ? null : stringOrNull(normalization.observedSubtreeFingerprint),
    translationWrapperFingerprint:
      wrappers === null ? null : stringOrNull(wrappers.translationWrapperFingerprint),
    centerRotationWrapperFingerprint:
      wrappers === null ? null : stringOrNull(wrappers.centerRotationWrapperFingerprint),
    completeMatrixFingerprint:
      wrappers === null ? null : stringOrNull(wrappers.completeMatrixFingerprint),
    flipShellIdentity: wrappers === null ? false : boolOrFalse(wrappers.flipShellIdentity),
    wrapperStructureValidated:
      wrappers === null ? false : boolOrFalse(wrappers.wrapperStructureValidated),
    // Purpose-scoped interaction authority only: no post-action hit status,
    // classification, obstruction, or candidate ever reaches a result.
    baselinePhase: baselineInteraction === null ? null : stringOrNull(baselineInteraction.phase),
    baselinePurpose:
      baselineInteraction === null ? null : stringOrNull(baselineInteraction.purpose),
    baselineAuthority:
      baselineInteraction === null ? null : stringOrNull(baselineInteraction.authority),
    observedPhase: observedInteraction === null ? null : stringOrNull(observedInteraction.phase),
    observedPurpose:
      observedInteraction === null ? null : stringOrNull(observedInteraction.purpose),
    observedAuthority:
      observedInteraction === null ? null : stringOrNull(observedInteraction.authority),
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
 * Validates the accepted nested-Object evaluator facts against the compiled
 * required-check set: a declared check may have exactly one well-formed
 * structured fact, and an undeclared check fact is rejected without being
 * consumed. It reports a malformed authority as a structured issue and never
 * reads a boolean check result.
 */
function validateCheckFacts(
  profile: ResolvedCorrectnessProfile,
  facts: NestedObjectKernelFacts,
  issues: NestedObjectKernelIssue[],
): void {
  const declaredIds = new Set(profile.requiredChecks.map((entry) => entry.checkId));
  const seenFactIds = new Set<string>();
  let authorityMalformed = false;
  for (const entry of Array.isArray(facts.checks) ? facts.checks : []) {
    const fact = entry as unknown;
    if (!isPlainRecord(fact) || typeof fact.checkId !== 'string') {
      issues.push(
        issue(
          'NESTED_OBJECT_KERNEL_FACT_STATUS_UNKNOWN',
          'A nested-Object evaluator fact has no check id.',
        ),
      );
      continue;
    }
    if (seenFactIds.has(fact.checkId)) {
      issues.push(
        issue(
          'NESTED_OBJECT_KERNEL_FACT_CHECK_DUPLICATE',
          `Nested-Object evaluator fact "${fact.checkId}" appears more than once.`,
          fact.checkId,
        ),
      );
      continue;
    }
    seenFactIds.add(fact.checkId);
    if (!declaredIds.has(fact.checkId)) {
      issues.push(
        issue(
          'NESTED_OBJECT_KERNEL_FACT_CHECK_UNKNOWN',
          `Nested-Object evaluator fact "${fact.checkId}" is not a declared required check.`,
          fact.checkId,
        ),
      );
    }
    if (!isWellFormedEvaluatorFact(fact)) {
      issues.push(
        issue(
          'NESTED_OBJECT_KERNEL_FACT_STATUS_UNKNOWN',
          `Nested-Object evaluator fact "${fact.checkId}" carries no explicit structured authority/currentness/source-agreement/mismatch facts.`,
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
        'NESTED_OBJECT_KERNEL_ORACLE_FACTS_ABSENT',
        'The accepted nested-Object Oracle produced no facts; no required check can be trusted.',
      ),
    );
  }
  if (authorityMalformed) {
    issues.push(
      issue(
        'NESTED_OBJECT_KERNEL_AUTHORITY_MALFORMED',
        'The accepted nested-Object evaluator authority is malformed (unreadable typed source or camera authority degeneracy); no required check can be trusted.',
      ),
    );
  }
}

function runNestedObjectKernel(input: NestedObjectKernelInput): NestedObjectKernelResult {
  const { profile, route, actionCycle, facts } = input;
  const issues = validateProfile(profile, route, actionCycle);
  if (issues.length > 0) {
    return { kind: NESTED_OBJECT_KERNEL_EVALUATOR, ok: false, checks: [], issues };
  }

  if (facts.evaluator !== NESTED_OBJECT_KERNEL_EVALUATOR) {
    issues.push(
      issue(
        'NESTED_OBJECT_KERNEL_FACTS_EVALUATOR_MISMATCH',
        `Nested-Object facts declare evaluator "${String(facts.evaluator)}" instead of "${NESTED_OBJECT_KERNEL_EVALUATOR}".`,
      ),
    );
  }

  validateCheckFacts(profile, facts, issues);

  const factById = new Map<string, NestedObjectEvaluatorFact>();
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
    if (fact === null) {
      issues.push(
        issue(
          'NESTED_OBJECT_KERNEL_FACT_CHECK_MISSING',
          `No accepted nested-Object evaluator fact exists for declared check "${contract.checkId}".`,
          contract.checkId,
        ),
      );
    }
    const status = resolveStructuredStatus(
      fact,
      evidence.authoritative && facts.oracleFacts !== null,
    );
    checks.push(
      buildCheckResult(
        profile,
        actionCycle,
        contract,
        status,
        expectedPayload(profile, contract, facts),
        actualPayload(contract, facts, evidence, fact),
        evidence.consumed,
      ),
    );
  }

  return { kind: NESTED_OBJECT_KERNEL_EVALUATOR, ok: true, checks, issues };
}

/**
 * The nested-Object final kernel. It evaluates the profile's declared
 * `nested-object-affine` checks from the accepted nested-Object Oracle facts.
 */
export function evaluateNestedObjectChecks(
  input: NestedObjectKernelInput,
): NestedObjectKernelResult {
  return runNestedObjectKernel(input);
}

/** Runtimes dispatch to exactly one nested-Object kernel kind. */
export function nestedObjectKernelKindForEvaluator(
  evaluatorKind: string | null | undefined,
): NestedObjectKernelKind | null {
  return evaluatorKind === NESTED_OBJECT_KERNEL_EVALUATOR ? NESTED_OBJECT_KERNEL_EVALUATOR : null;
}
