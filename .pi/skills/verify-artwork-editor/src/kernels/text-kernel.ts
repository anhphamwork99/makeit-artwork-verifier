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
 * P7-B B1-B inactive final compiled-profile kernels for ordinary and
 * circle-warped Text (ADR 0028 §3 B1-B).
 *
 * Each kernel is a pure function. It receives exactly three things:
 *
 *  1. the immutable compiled `ResolvedCorrectnessProfile`;
 *  2. the Action Cycle correctness identity that observed the action; and
 *  3. the accepted evaluator facts/evidence already produced by the delivered
 *     runtime's Oracle evaluation.
 *
 * It returns one complete, field-rich `CorrectnessCheckResult` per declared
 * required check — or, when the compiled profile itself is not trustworthy, no
 * fabricated checks at all.
 *
 * Every correctness input is read from the compiled profile. This module owns no
 * required-check list, no tolerance/visual/normalization literal, no fallback
 * id, and no Subject-name/family/scenario branch; it never reloads an authoring
 * catalogue. The accepted WP5 meaning is preserved exactly: a trustworthy
 * product mismatch is `FAIL`, missing/stale/torn/ambiguous/uninterpretable
 * authority is `UNUSABLE`, and a diagnostic-only item can never rescue a
 * required check.
 *
 * The kernels are deliberately inactive. Nothing here is imported by the active
 * executor, Oracle, classifier, writer, or CLI, and no module under `src/runtime`
 * or `src/oracles` is imported in return: the fact contracts below are
 * structurally satisfied by the accepted evaluator results, so the atomic B2
 * cutover can pass them in without this module depending on active machinery.
 */

/** The two delivered Text evaluator families a kernel can own. */
export const TEXT_KERNEL_KINDS = ['text-ordinary', 'text-warped'] as const;
export type TextKernelKind = (typeof TEXT_KERNEL_KINDS)[number];

/**
 * Closed evidence-availability vocabulary. Only `authoritative` evidence is
 * current and interpretable; every other state makes a required check
 * `UNUSABLE`. `diagnostic-only` is the single role that must never satisfy a
 * required check.
 */
export const TEXT_EVIDENCE_AVAILABILITY = [
  'authoritative',
  'ambiguous',
  'diagnostic-only',
  'malformed',
  'missing',
  'stale',
  'torn',
] as const;
export type TextEvidenceAvailability = (typeof TEXT_EVIDENCE_AVAILABILITY)[number];

export function isTextEvidenceAvailability(value: unknown): value is TextEvidenceAvailability {
  return (
    typeof value === 'string' && (TEXT_EVIDENCE_AVAILABILITY as readonly string[]).includes(value)
  );
}

/** One accepted evidence fact the runtime actually observed for a check. */
export interface TextEvidenceFact {
  readonly evidenceId: string;
  readonly availability: TextEvidenceAvailability;
}

/** A finite `{ x, y }` vector, structurally identical to the accepted geometry points. */
export interface TextKernelVector {
  readonly x: number;
  readonly y: number;
}

/** The route a kernel is asked to evaluate. Passed in; never selected internally. */
export interface TextKernelRoute {
  readonly subjectId: string;
  readonly capability: Capability;
  readonly variant: string | null;
}

/**
 * The explicit structured evaluator-fact view every Text kernel check consumes
 * (ADR 0029 §4 B2-B).
 *
 * It replaces the legacy aggregate `harnessInvalid` flag and the legacy
 * per-check boolean `passed`: authority, currentness, source agreement, and
 * product mismatch are carried as separate structured facts, so the kernel maps
 * them to a status from explicit structure instead of translating a boolean
 * check result. The facts are supplied by the inactive live-fact adapters from
 * the delivered Oracle/runtime observations; this module owns no predicate
 * policy of its own.
 */
export interface TextEvaluatorFact {
  readonly checkId: string;
  /** Structured authority state of the accepted evaluator fact. */
  readonly authority: TextAuthorityState;
  /** Structured currentness of the accepted evaluator fact. */
  readonly currentness: TextFactCurrentness;
  /** Whether the independent authoritative sources agreed. */
  readonly sourcesAgree: boolean;
  /** A trustworthy product mismatch under a current authority. */
  readonly mismatch: boolean;
}

/**
 * The accepted ordinary-Text `geometry.delta` evaluator result projected into
 * explicit structured facts. Every numeric/detail field is the delivered
 * Oracle's own source fact; `authority`/`currentness`/`mismatch` are the
 * structured interpretation the adapter derived from those facts.
 */
export interface OrdinaryTextDeltaFact extends TextEvaluatorFact {
  readonly canonicalDelta: TextKernelVector | null;
  readonly renderedDelta: TextKernelVector | null;
  readonly agreement: TextKernelVector | null;
  readonly canonicalMet: boolean;
  readonly renderedMet: boolean;
  readonly detail: string;
}

/** Accepted ordinary-Text evaluator facts plus the observed evidence roles. */
export interface OrdinaryTextKernelFacts {
  readonly evaluator: 'canonical-delta';
  /** The Case Intent's accepted minimum delta, or `null` when it is unusable. */
  readonly minimumDelta: TextKernelVector | null;
  /** The accepted `geometry.delta` result, or `null` when the Oracle never ran. */
  readonly check: OrdinaryTextDeltaFact | null;
  readonly evidence: readonly TextEvidenceFact[];
}

/**
 * One accepted per-check warped-Text evaluator fact in explicit structured
 * form. The legacy boolean `passed` is replaced by structured authority,
 * currentness, source-agreement, and mismatch facts.
 */
export type WarpedTextCheckFact = TextEvaluatorFact;

/** Accepted warped-Text `WarpedDeltaEvidence`. */
export interface WarpedTextDeltaEvidenceFact {
  readonly canonicalDelta: TextKernelVector | null;
  readonly canonicalMet: boolean;
  readonly expectedRendererDelta: TextKernelVector | null;
  readonly maxPointAxisDeviation: number | null;
  readonly rendererDeltaPerPoint: readonly TextKernelVector[] | null;
}

/** Accepted warped-Text `WarpedEnvelopeEvidence`. */
export interface WarpedTextEnvelopeEvidenceFact {
  readonly baselineFingerprint: string | null;
  readonly observedFingerprint: string | null;
  readonly maxCanonicalDeviation: number | null;
  readonly maxRenderedDeviation: number | null;
}

/**
 * Accepted warped-Text evaluator facts plus the observed evidence roles.
 *
 * The legacy aggregate `harnessInvalid` flag and the legacy per-check
 * `passed` boolean are deliberately absent: `checks` carries the explicit
 * structured authority/currentness/source-agreement/mismatch facts for every
 * declared check, and `delta`/`envelope` carry the raw source evidence the
 * adapter observed.
 */
export interface WarpedTextKernelFacts {
  readonly evaluator: 'typed-envelope';
  readonly minimumDelta: TextKernelVector | null;
  readonly checks: readonly WarpedTextCheckFact[];
  readonly delta: WarpedTextDeltaEvidenceFact | null;
  readonly envelope: WarpedTextEnvelopeEvidenceFact | null;
  readonly evidence: readonly TextEvidenceFact[];
}

/** Closed authority state recorded in every `actual` interpretation. */
export const TEXT_AUTHORITY_STATES = [
  'ambiguous',
  'current',
  'malformed',
  'missing',
  'stale',
  'torn',
  'unavailable',
] as const;
export type TextAuthorityState = (typeof TEXT_AUTHORITY_STATES)[number];

/**
 * Closed structured currentness vocabulary for one accepted evaluator fact
 * (ADR 0029 §4 B2-B). Currentness is an explicit structured fact recorded per
 * check; it is never a final result status.
 */
export const TEXT_FACT_CURRENTNESS = ['current', 'stale', 'torn', 'unavailable'] as const;
export type TextFactCurrentness = (typeof TEXT_FACT_CURRENTNESS)[number];

export function isTextFactCurrentness(value: unknown): value is TextFactCurrentness {
  return typeof value === 'string' && (TEXT_FACT_CURRENTNESS as readonly string[]).includes(value);
}

/** Projects a structured authority state onto the closed currentness domain. */
export function textCurrentnessForAuthority(authority: TextAuthorityState): TextFactCurrentness {
  if (authority === 'current') return 'current';
  if (authority === 'stale') return 'stale';
  if (authority === 'torn') return 'torn';
  return 'unavailable';
}

function isTextAuthorityState(value: unknown): value is TextAuthorityState {
  return typeof value === 'string' && (TEXT_AUTHORITY_STATES as readonly string[]).includes(value);
}

/** Closed kernel issue vocabulary; deliberately local to the inactive kernel. */
export const TEXT_KERNEL_ISSUE_CODES = [
  'TEXT_KERNEL_PROFILE_NOT_OBJECT',
  'TEXT_KERNEL_PROFILE_SCHEMA_UNSUPPORTED',
  'TEXT_KERNEL_PROFILE_FINGERPRINT_MISSING',
  'TEXT_KERNEL_PROFILE_FINGERPRINT_INVALID',
  'TEXT_KERNEL_PROFILE_FINGERPRINT_MISMATCH',
  'TEXT_KERNEL_COMPONENT_FINGERPRINT_INVALID',
  'TEXT_KERNEL_ROUTE_MISMATCH',
  'TEXT_KERNEL_ORACLE_EVALUATOR_UNSUPPORTED',
  'TEXT_KERNEL_CHECK_EVALUATOR_UNSUPPORTED',
  'TEXT_KERNEL_REQUIRED_CHECK_MISSING',
  'TEXT_KERNEL_REQUIRED_CHECK_DUPLICATE',
  'TEXT_KERNEL_EMPTY_REQUIRED_CHECKS',
  'TEXT_KERNEL_ACTION_CYCLE_MISMATCH',
  'TEXT_KERNEL_READINESS_MISMATCH',
  'TEXT_KERNEL_FACTS_EVALUATOR_MISMATCH',
  'TEXT_KERNEL_FACT_CHECK_MISSING',
  'TEXT_KERNEL_FACT_CHECK_UNKNOWN',
  'TEXT_KERNEL_FACT_STATUS_UNKNOWN',
  'TEXT_KERNEL_EVIDENCE_UNDECLARED',
  'TEXT_KERNEL_EVIDENCE_DIAGNOSTIC_ONLY',
] as const;
export type TextKernelIssueCode = (typeof TEXT_KERNEL_ISSUE_CODES)[number];

export interface TextKernelIssue {
  readonly code: TextKernelIssueCode;
  readonly detail: string;
  readonly checkId: string | null;
}

export interface TextKernelResult {
  readonly kind: TextKernelKind;
  /**
   * `true` when the compiled profile was trustworthy and a complete check
   * result was produced for every declared check (possibly all `UNUSABLE`).
   * `false` when the profile itself failed validation; `checks` is then empty
   * because no trustworthy check may be fabricated from an invalid profile.
   */
  readonly ok: boolean;
  readonly checks: readonly CorrectnessCheckResult[];
  readonly issues: readonly TextKernelIssue[];
}

export interface TextKernelInput<Facts> {
  readonly profile: ResolvedCorrectnessProfile;
  readonly route: TextKernelRoute;
  readonly actionCycle: ActionCycleCorrectnessIdentity;
  readonly facts: Facts;
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
  code: TextKernelIssueCode,
  detail: string,
  checkId: string | null = null,
): TextKernelIssue {
  return { code, detail, checkId };
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

function sortStrings(values: readonly string[]): string[] {
  return [...values].sort();
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
 * Validates that the compiled profile is exactly the immutable profile for the
 * requested route and that the Action Cycle observed the same profile. Every
 * failure is fail-closed and reported as a structured issue; the fingerprint is
 * independently recomputed from the profile content so a mutated compiled field
 * is detected rather than trusted.
 */
function validateProfile(
  profile: ResolvedCorrectnessProfile,
  route: TextKernelRoute,
  actionCycle: ActionCycleCorrectnessIdentity,
  supportedOracleEvaluator: string,
  supportedCheckEvaluators: readonly string[],
): TextKernelIssue[] {
  const issues: TextKernelIssue[] = [];
  if (!isPlainRecord(profile)) {
    issues.push(
      issue('TEXT_KERNEL_PROFILE_NOT_OBJECT', 'The compiled profile is not a plain object.'),
    );
    return issues;
  }
  if (profile.schemaVersion !== RESOLVED_CORRECTNESS_PROFILE_SCHEMA_VERSION) {
    issues.push(
      issue(
        'TEXT_KERNEL_PROFILE_SCHEMA_UNSUPPORTED',
        `Resolved-profile schema ${String(profile.schemaVersion)} is not supported.`,
      ),
    );
  }

  const storedFingerprint = profile.resolvedFingerprint;
  if (storedFingerprint === undefined || storedFingerprint === null) {
    issues.push(
      issue(
        'TEXT_KERNEL_PROFILE_FINGERPRINT_MISSING',
        'The compiled profile carries no resolved fingerprint.',
      ),
    );
  } else if (!isFullCanonicalFingerprint(storedFingerprint)) {
    issues.push(
      issue(
        'TEXT_KERNEL_PROFILE_FINGERPRINT_INVALID',
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
          'TEXT_KERNEL_PROFILE_FINGERPRINT_MISMATCH',
          'The compiled resolved fingerprint does not match the profile content; a compiled field was mutated.',
        ),
      );
    }
  }

  const componentFingerprints = profile.componentFingerprints;
  if (!isPlainRecord(componentFingerprints)) {
    issues.push(
      issue(
        'TEXT_KERNEL_COMPONENT_FINGERPRINT_INVALID',
        'The compiled profile carries no component fingerprints.',
      ),
    );
  } else {
    for (const field of COMPONENT_FINGERPRINT_FIELDS) {
      if (!isFullCanonicalFingerprint(componentFingerprints[field])) {
        issues.push(
          issue(
            'TEXT_KERNEL_COMPONENT_FINGERPRINT_INVALID',
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
        'TEXT_KERNEL_ROUTE_MISMATCH',
        `Compiled profile route ${profile.subjectId}×${String(profile.capability)}@${profile.variant ?? '∅'} does not equal the requested route ${route.subjectId}×${String(route.capability)}@${route.variant ?? '∅'}.`,
      ),
    );
  }

  const oracle: unknown = profile.oracle;
  if (!isPlainRecord(oracle) || oracle.evaluatorKind !== supportedOracleEvaluator) {
    const found = isPlainRecord(oracle) ? String(oracle.evaluatorKind) : 'undefined';
    issues.push(
      issue(
        'TEXT_KERNEL_ORACLE_EVALUATOR_UNSUPPORTED',
        `Compiled Oracle evaluator "${found}" is not supported by this Text kernel (expected "${supportedOracleEvaluator}").`,
      ),
    );
  }

  const requiredChecks = Array.isArray(profile.requiredChecks) ? profile.requiredChecks : [];
  if (requiredChecks.length === 0) {
    issues.push(
      issue(
        'TEXT_KERNEL_EMPTY_REQUIRED_CHECKS',
        'A compiled profile with no declared required check cannot produce a check result.',
      ),
    );
  }
  const seen = new Set<string>();
  for (const check of requiredChecks) {
    const checkId = typeof check.checkId === 'string' ? check.checkId : null;
    if (checkId === null) {
      issues.push(
        issue('TEXT_KERNEL_REQUIRED_CHECK_MISSING', 'A declared required check has no check id.'),
      );
      continue;
    }
    if (seen.has(checkId)) {
      issues.push(
        issue(
          'TEXT_KERNEL_REQUIRED_CHECK_DUPLICATE',
          `Declared required check "${checkId}" appears more than once.`,
          checkId,
        ),
      );
      continue;
    }
    seen.add(checkId);
    if (
      typeof check.evaluator !== 'string' ||
      !supportedCheckEvaluators.includes(check.evaluator)
    ) {
      issues.push(
        issue(
          'TEXT_KERNEL_CHECK_EVALUATOR_UNSUPPORTED',
          `Required check "${checkId}" declares evaluator "${String(check.evaluator)}" which this Text kernel does not support.`,
          checkId,
        ),
      );
    }
  }

  if (actionCycle.resolvedProfileFingerprint !== storedFingerprint) {
    issues.push(
      issue(
        'TEXT_KERNEL_ACTION_CYCLE_MISMATCH',
        'The Action Cycle resolved-profile fingerprint does not equal the compiled profile fingerprint.',
      ),
    );
  }
  if (actionCycle.readinessFingerprint !== profile.componentFingerprints?.readiness) {
    issues.push(
      issue(
        'TEXT_KERNEL_READINESS_MISMATCH',
        'The Action Cycle readiness fingerprint does not equal the compiled readiness component.',
      ),
    );
  }
  return issues;
}

interface EvidenceConsumption {
  readonly consumed: readonly string[];
  readonly authoritative: boolean;
  readonly authorityState: TextAuthorityState;
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
  facts: readonly TextEvidenceFact[],
  issues: TextKernelIssue[],
): EvidenceConsumption {
  const checkId = contract.checkId;
  const byId = new Map<string, TextEvidenceFact>();
  for (const fact of facts) {
    if (isPlainRecord(fact) && typeof fact.evidenceId === 'string') {
      byId.set(fact.evidenceId, fact as unknown as TextEvidenceFact);
    }
  }
  const globalDeclared = new Set(profile.requiredAuthoritativeEvidence);
  const consumed: string[] = [];
  let authorityState: TextAuthorityState = 'current';

  for (const requiredId of sortStrings(contract.requiredEvidence)) {
    if (!globalDeclared.has(requiredId)) {
      issues.push(
        issue(
          'TEXT_KERNEL_EVIDENCE_UNDECLARED',
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
          'TEXT_KERNEL_EVIDENCE_DIAGNOSTIC_ONLY',
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
          'TEXT_KERNEL_EVIDENCE_UNDECLARED',
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

function expectedPayload(
  profile: ResolvedCorrectnessProfile,
  contract: ResolvedCheckContract,
  minimumDelta: TextKernelVector | null,
): Record<string, unknown> {
  return {
    schema: contract.expectedSchema,
    evaluator: contract.evaluator,
    oracleProfileId: profile.oracle.oracleProfileId,
    checkId: contract.checkId,
    minimumDelta: isVector(minimumDelta) ? { x: minimumDelta.x, y: minimumDelta.y } : null,
    requiredEvidence: sortStrings(contract.requiredEvidence),
    toleranceRefs: sortStrings(contract.toleranceRefs),
    visualRefs: sortStrings(contract.visualRefs),
    normalizationRef: contract.normalizationRef,
  };
}

function ordinaryFactsUsable(facts: OrdinaryTextKernelFacts, checkId: string): boolean {
  return isPlainRecord(facts.check) && facts.check.checkId === checkId;
}

/**
 * A structured evaluator fact is well formed only when authority/currentness are
 * closed values and the source-agreement/mismatch facts are explicit booleans.
 * A fact that is not well formed is reported and can never be read as current.
 */
function isWellFormedEvaluatorFact(value: unknown): value is TextEvaluatorFact {
  if (!isPlainRecord(value)) return false;
  return (
    isTextAuthorityState(value.authority) &&
    isTextFactCurrentness(value.currentness) &&
    typeof value.sourcesAgree === 'boolean' &&
    typeof value.mismatch === 'boolean'
  );
}

function factAuthority(
  fact: TextEvaluatorFact | null,
  evidence: EvidenceConsumption,
): TextAuthorityState {
  if (fact === null) return 'missing';
  return evidence.authoritative ? fact.authority : evidence.authorityState;
}

/**
 * Maps explicit structured facts to the three-state result: only a current fact
 * with authoritative required evidence can be PASS or FAIL; a trustworthy
 * product mismatch under current authority is FAIL and everything else is
 * UNUSABLE. No boolean check result is translated into a status.
 */
function resolveStructuredStatus(
  fact: TextEvaluatorFact | null,
  evidenceAuthoritative: boolean,
): CheckResultStatus {
  if (fact === null || fact.authority !== 'current' || !evidenceAuthoritative) {
    return 'UNUSABLE';
  }
  return fact.mismatch ? 'FAIL' : 'PASS';
}

function runOrdinaryTextKernel(input: TextKernelInput<OrdinaryTextKernelFacts>): TextKernelResult {
  const { profile, route, actionCycle, facts } = input;
  const issues = validateProfile(profile, route, actionCycle, 'geometry-delta', [
    'canonical-delta',
  ]);
  if (issues.length > 0) {
    return { kind: 'text-ordinary', ok: false, checks: [], issues };
  }

  if (facts.evaluator !== 'canonical-delta') {
    issues.push(
      issue(
        'TEXT_KERNEL_FACTS_EVALUATOR_MISMATCH',
        `Ordinary-Text facts declare evaluator "${String(facts.evaluator)}" instead of "canonical-delta".`,
      ),
    );
  }

  const checks: CorrectnessCheckResult[] = [];
  for (const contract of profile.requiredChecks) {
    const evidence = consumeRequiredEvidence(
      contract,
      profile,
      Array.isArray(facts.evidence) ? facts.evidence : [],
      issues,
    );
    const candidate = ordinaryFactsUsable(facts, contract.checkId) ? facts.check : null;
    const fact = candidate !== null && isWellFormedEvaluatorFact(candidate) ? candidate : null;
    if (candidate === null) {
      issues.push(
        issue(
          'TEXT_KERNEL_FACT_CHECK_MISSING',
          `No accepted ordinary-Text evaluator fact exists for declared check "${contract.checkId}".`,
          contract.checkId,
        ),
      );
    } else if (fact === null) {
      issues.push(
        issue(
          'TEXT_KERNEL_FACT_STATUS_UNKNOWN',
          `The ordinary-Text evaluator fact for "${contract.checkId}" carries no explicit structured authority/currentness/mismatch facts.`,
          contract.checkId,
        ),
      );
    }
    const status: CheckResultStatus = resolveStructuredStatus(fact, evidence.authoritative);
    const actual = {
      schema: contract.actualSchema,
      authority: factAuthority(fact, evidence),
      currentness: fact === null ? 'unavailable' : fact.currentness,
      mismatch: fact?.mismatch ?? false,
      sourcesAgree: fact?.sourcesAgree ?? false,
      canonicalDelta: fact?.canonicalDelta ?? null,
      renderedDelta: fact?.renderedDelta ?? null,
      agreement: fact?.agreement ?? null,
      canonicalMet: fact?.canonicalMet ?? false,
      renderedMet: fact?.renderedMet ?? false,
      detail: fact?.detail ?? 'The accepted geometry.delta evaluator produced no fact.',
    };
    checks.push(
      buildCheckResult(
        profile,
        actionCycle,
        contract,
        status,
        expectedPayload(
          profile,
          contract,
          isVector(facts.minimumDelta) ? facts.minimumDelta : null,
        ),
        actual,
        evidence.consumed,
      ),
    );
  }

  return { kind: 'text-ordinary', ok: true, checks, issues };
}

function warpedFactFor(facts: WarpedTextKernelFacts, checkId: string): WarpedTextCheckFact | null {
  if (!Array.isArray(facts.checks)) return null;
  return facts.checks.find((entry) => isPlainRecord(entry) && entry.checkId === checkId) ?? null;
}

function runWarpedTextKernel(input: TextKernelInput<WarpedTextKernelFacts>): TextKernelResult {
  const { profile, route, actionCycle, facts } = input;
  const issues = validateProfile(profile, route, actionCycle, 'warped-text-envelope', [
    'typed-envelope',
  ]);
  if (issues.length > 0) {
    return { kind: 'text-warped', ok: false, checks: [], issues };
  }

  if (facts.evaluator !== 'typed-envelope') {
    issues.push(
      issue(
        'TEXT_KERNEL_FACTS_EVALUATOR_MISMATCH',
        `Warped-Text facts declare evaluator "${String(facts.evaluator)}" instead of "typed-envelope".`,
      ),
    );
  }
  const declaredIds = new Set(profile.requiredChecks.map((entry) => entry.checkId));
  const seenFactIds = new Set<string>();
  for (const fact of Array.isArray(facts.checks) ? facts.checks : []) {
    if (typeof fact?.checkId !== 'string') {
      issues.push(
        issue('TEXT_KERNEL_FACT_STATUS_UNKNOWN', 'A warped-Text check fact has no check id.'),
      );
      continue;
    }
    if (seenFactIds.has(fact.checkId)) {
      issues.push(
        issue(
          'TEXT_KERNEL_FACT_CHECK_UNKNOWN',
          `Warped-Text check fact "${fact.checkId}" appears more than once.`,
          fact.checkId,
        ),
      );
      continue;
    }
    seenFactIds.add(fact.checkId);
    if (!declaredIds.has(fact.checkId)) {
      issues.push(
        issue(
          'TEXT_KERNEL_FACT_CHECK_UNKNOWN',
          `Warped-Text check fact "${fact.checkId}" is not a declared required check.`,
          fact.checkId,
        ),
      );
    }
    if (!isWellFormedEvaluatorFact(fact)) {
      issues.push(
        issue(
          'TEXT_KERNEL_FACT_STATUS_UNKNOWN',
          `Warped-Text check fact "${String(fact?.checkId)}" carries no explicit structured authority/currentness/source-agreement/mismatch facts.`,
          typeof fact?.checkId === 'string' ? fact.checkId : null,
        ),
      );
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
    const candidate = warpedFactFor(facts, contract.checkId);
    const fact = candidate !== null && isWellFormedEvaluatorFact(candidate) ? candidate : null;
    if (candidate === null) {
      issues.push(
        issue(
          'TEXT_KERNEL_FACT_CHECK_MISSING',
          `No accepted warped-Text evaluator fact exists for declared check "${contract.checkId}".`,
          contract.checkId,
        ),
      );
    }
    const status: CheckResultStatus = resolveStructuredStatus(fact, evidence.authoritative);
    const actual = {
      schema: contract.actualSchema,
      authority: factAuthority(fact, evidence),
      currentness: fact === null ? 'unavailable' : fact.currentness,
      mismatch: fact?.mismatch ?? false,
      sourcesAgree: fact?.sourcesAgree ?? false,
      canonicalDelta: facts.delta?.canonicalDelta ?? null,
      canonicalMet: facts.delta?.canonicalMet ?? false,
      expectedRendererDelta: facts.delta?.expectedRendererDelta ?? null,
      maxPointAxisDeviation: facts.delta?.maxPointAxisDeviation ?? null,
      rendererDeltaPerPoint: facts.delta?.rendererDeltaPerPoint ?? null,
      baselineEnvelopeFingerprint: facts.envelope?.baselineFingerprint ?? null,
      observedEnvelopeFingerprint: facts.envelope?.observedFingerprint ?? null,
      maxCanonicalDeviation: facts.envelope?.maxCanonicalDeviation ?? null,
      maxRenderedDeviation: facts.envelope?.maxRenderedDeviation ?? null,
    };
    checks.push(
      buildCheckResult(
        profile,
        actionCycle,
        contract,
        status,
        expectedPayload(
          profile,
          contract,
          isVector(facts.minimumDelta) ? facts.minimumDelta : null,
        ),
        actual,
        evidence.consumed,
      ),
    );
  }

  return { kind: 'text-warped', ok: true, checks, issues };
}

/**
 * The ordinary-Text final kernel. It evaluates the profile's declared
 * `canonical-delta` checks from the accepted ordinary-Text Oracle facts.
 */
export function evaluateOrdinaryTextChecks(
  input: TextKernelInput<OrdinaryTextKernelFacts>,
): TextKernelResult {
  return runOrdinaryTextKernel(input);
}

/**
 * The circle-warped-Text final kernel. It evaluates the profile's declared
 * `typed-envelope` checks from the accepted warped-Text Oracle facts.
 */
export function evaluateWarpedTextChecks(
  input: TextKernelInput<WarpedTextKernelFacts>,
): TextKernelResult {
  return runWarpedTextKernel(input);
}

/** Runtimes dispatch to exactly one Text kernel kind. */
export function textKernelKindForEvaluator(
  evaluatorKind: string | null | undefined,
): TextKernelKind | null {
  if (evaluatorKind === 'geometry-delta') return 'text-ordinary';
  if (evaluatorKind === 'warped-text-envelope') return 'text-warped';
  return null;
}
