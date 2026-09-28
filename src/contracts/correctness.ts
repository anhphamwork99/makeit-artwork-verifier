import type { Capability } from './discriminants';

/**
 * Package 7 Slice A correctness-contract schemas (ADR 0023).
 *
 * These are the strict, versioned declarations that become the planning and
 * static-validation authority for every currently delivered execution route:
 * readiness, coherent capture, Oracle composition, tolerances, visual
 * authority, normalization, and the composed required-check set. Every document
 * is closed — unknown keys, versions, and discriminants fail closed — and every
 * resolved contract is immutable and complete, because no planning decision may
 * depend on an omitted field meaning an implicit default.
 *
 * P7-A additionally defines the closed `PASS | FAIL | UNUSABLE` required-check
 * result contract. It deliberately does **not** migrate active runtime result
 * handling: the existing boolean runtime representation remains a temporary
 * compatibility surface until P7-B. Defining the schema is not claiming the
 * browser/runtime records already preserve the three states.
 */

/** Closed three-state required-check result domain (P7-A contract only). */
export const CHECK_RESULT_STATUSES = ['FAIL', 'PASS', 'UNUSABLE'] as const;
export type CheckResultStatus = (typeof CHECK_RESULT_STATUSES)[number];

export function isCheckResultStatus(value: unknown): value is CheckResultStatus {
  return typeof value === 'string' && (CHECK_RESULT_STATUSES as readonly string[]).includes(value);
}

/**
 * Full canonical identity shape: a lowercase, domain-separated SHA-256 digest.
 *
 * Every fingerprint carried by a final result contract is a full canonical
 * 64-hex identity, never an abbreviated hash, an `id@version` substitute, or a
 * truncated display value.
 */
export const FULL_CANONICAL_FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;

export function isFullCanonicalFingerprint(value: unknown): value is string {
  return typeof value === 'string' && FULL_CANONICAL_FINGERPRINT_PATTERN.test(value);
}

/**
 * The exact resolved-profile component fingerprints one check consumed (ADR
 * 0028 §2). It mirrors `CorrectnessComponentFingerprints` but names only the
 * components that a check result actually consumed: the resolved projection
 * plus its required-check set, Oracle, capture, tolerance, visual, and
 * normalization identities.
 *
 * Readiness identity is deliberately absent: it is recorded once per Action
 * Cycle in `ActionCycleCorrectnessIdentity` and linked through
 * `CorrectnessCheckResult.actionCycleRef` rather than copied into every check.
 */
export interface ConsumedCorrectnessComponentFingerprints {
  resolvedProfile: string;
  requiredCheckSet: string;
  oracle: string;
  capture: string;
  tolerances: string;
  visuals: string;
  normalization: string;
}

/**
 * One required-check result under the closed three-state contract.
 *
 * `PASS` is a trustworthy match, `FAIL` a trustworthy product mismatch, and
 * `UNUSABLE` missing/stale/torn/ambiguous/uninterpretable authority. The three
 * states are preserved on the check record itself rather than reconstructed
 * from a boolean plus side-channel flags.
 *
 * `actionCycleRef` binds the check to exactly one Action Cycle identity in the
 * same current record, and `consumedComponentFingerprints` records the exact
 * compiled-profile components the check consumed (ADR 0025 §3, ADR 0028 §2).
 */
export interface CorrectnessCheckResult {
  schemaVersion: number;
  checkId: string;
  status: CheckResultStatus;
  expected: Readonly<Record<string, unknown>>;
  actual: Readonly<Record<string, unknown>>;
  evidenceIds: readonly string[];
  toleranceRefs: readonly string[];
  visualRefs: readonly string[];
  normalizationRef: string | null;
  /** Resolves to exactly one `ActionCycleCorrectnessIdentity` in the record. */
  actionCycleRef: string;
  consumedComponentFingerprints: ConsumedCorrectnessComponentFingerprints;
}

/**
 * One Action Cycle correctness identity (ADR 0028 §2). Readiness identity is
 * recorded once per Action Cycle and linked to every check in that cycle, so a
 * check never duplicates readiness policy content.
 */
export interface ActionCycleCorrectnessIdentity {
  schemaVersion: number;
  actionCycleId: string;
  /** Must equal the `consumedComponentFingerprints.resolvedProfile` of its checks. */
  resolvedProfileFingerprint: string;
  /** The compiled readiness component fingerprint recorded once per cycle. */
  readinessFingerprint: string;
}

/** Named readiness deadline categories. */
export const DEADLINE_CATEGORIES = [
  'DERIVED_GENERATION_V1',
  'FRONTEND_RESTORE_V1',
  'INTERACTIVE_HISTORY_V1',
  'INTERACTIVE_RENDER_V1',
  'RESOURCE_RENDER_V1',
] as const;
export type DeadlineCategory = (typeof DEADLINE_CATEGORIES)[number];

export function isDeadlineCategory(value: unknown): value is DeadlineCategory {
  return typeof value === 'string' && (DEADLINE_CATEGORIES as readonly string[]).includes(value);
}

/**
 * Authoring readiness declaration (ADR 0023 §2 "Readiness").
 *
 * `fallbackCadenceMs` is ordered policy data: its sequence is meaningful and
 * must fingerprint differently when reordered. `currentnessIdentities` is an
 * unordered set and is normalized before hashing.
 */
export interface ReadinessDeclaration {
  schemaVersion: number;
  profileId: string;
  version: number;
  deadlineCategory: DeadlineCategory;
  deadlineMs: number;
  signalWatchdogMs: number;
  fallbackCadenceMs: readonly number[];
  stableFrames: number;
  quiescenceRequired: boolean;
  stableFrameRequired: boolean;
  currentnessIdentities: readonly string[];
  captureProfileId: string;
  oracleProfileId: string;
}

/** Closed coherent-capture source roles. */
export const CAPTURE_SOURCE_ROLES = [
  'canonical',
  'crossword-generation',
  'history',
  'normalization',
  'raster',
  'renderer',
  'semantic',
  'serialization',
] as const;
export type CaptureSourceRole = (typeof CAPTURE_SOURCE_ROLES)[number];

export function isCaptureSourceRole(value: unknown): value is CaptureSourceRole {
  return typeof value === 'string' && (CAPTURE_SOURCE_ROLES as readonly string[]).includes(value);
}

/**
 * One declared capture source. `currentness` lists the currentness identities
 * the source must share with the accepted anchor before it carries authority.
 */
export interface CaptureSourceDeclaration {
  sourceId: string;
  role: CaptureSourceRole;
  currentness: readonly string[];
  required: boolean;
}

/**
 * Authoring capture declaration (ADR 0023 §2 "Capture").
 *
 * `bracketing` is ordered capture sequencing and must retain order. `sources`
 * and `evidenceItemIds` are unordered sets and are normalized before hashing.
 */
export interface CaptureDeclaration {
  schemaVersion: number;
  captureProfileId: string;
  version: number;
  requiredSources: readonly CaptureSourceDeclaration[];
  bracketing: readonly string[];
  acceptedObservationRule: string;
  tornCandidateHandling: string;
  evidenceItemIds: readonly string[];
}

/** Closed Oracle evaluator discriminants (one per delivered evaluator family). */
export const ORACLE_EVALUATOR_KINDS = [
  'crossword-determinism',
  'frontend-restore',
  'geometry-delta',
  'history-cross-subject',
  'image-upload-replace',
  'nested-object-affine',
  'warped-text-envelope',
] as const;
export type OracleEvaluatorKind = (typeof ORACLE_EVALUATOR_KINDS)[number];

export function isOracleEvaluatorKind(value: unknown): value is OracleEvaluatorKind {
  return typeof value === 'string' && (ORACLE_EVALUATOR_KINDS as readonly string[]).includes(value);
}

/** Closed per-check evaluator discriminants. */
export const CHECK_EVALUATORS = [
  'canonical-delta',
  'crossword-determinism',
  'frontend-restore',
  'history-cross-subject',
  'image-structural',
  'nested-object-affine',
  'renderer-transform',
  'typed-envelope',
] as const;
export type CheckEvaluator = (typeof CHECK_EVALUATORS)[number];

export function isCheckEvaluator(value: unknown): value is CheckEvaluator {
  return typeof value === 'string' && (CHECK_EVALUATORS as readonly string[]).includes(value);
}

/** Closed currentness/correlation identity vocabulary. */
export const CURRENTNESS_IDENTITIES = [
  'bridge-generation',
  'crossword-generation',
  'document',
  'epoch',
  'history-snapshot',
  'raster',
  'renderer-stage',
  'restore-snapshot',
  'revision',
  'typed-chain-v3',
  'typed-envelope',
] as const;
export type CurrentnessIdentity = (typeof CURRENTNESS_IDENTITIES)[number];

export function isCurrentnessIdentity(value: unknown): value is CurrentnessIdentity {
  return typeof value === 'string' && (CURRENTNESS_IDENTITIES as readonly string[]).includes(value);
}

/** One required-check definition owned by an Oracle declaration. */
export interface OracleCheckDeclaration {
  checkId: string;
  evaluator: CheckEvaluator;
  expectedSchema: string;
  actualSchema: string;
  /** A set of required-authoritative evidence item ids (unordered). */
  requiredEvidence: readonly string[];
  /** Referenced tolerance declarations (unordered). */
  toleranceRefs: readonly string[];
  /** Referenced visual-authority declarations (unordered). */
  visualRefs: readonly string[];
  normalizationRef: string | null;
}

/** Closed Oracle declaration (ADR 0023 §2 "Oracle composition"). */
export interface OracleDeclaration {
  schemaVersion: number;
  oracleProfileId: string;
  version: number;
  evaluatorKind: OracleEvaluatorKind;
  checks: readonly OracleCheckDeclaration[];
  diagnosticOnlyEvidence: readonly string[];
}

/** Capability baseline: the accepted cross-Subject required checks. */
export interface CapabilityBaselineDeclaration {
  capability: Capability;
  checks: readonly string[];
}

/** Subject × Capability addition: Subject-specific required checks. */
export interface SubjectAdditionDeclaration {
  subjectId: string;
  capability: Capability;
  checks: readonly string[];
}

/**
 * Closed approved route/profile selection.
 *
 * A delivered route selects exactly one readiness profile (and therefore one
 * capture and Oracle profile) through this declaration. Selection is never a
 * runtime Subject-name branch or a case-supplied policy override.
 */
export interface RouteProfileSelectionDeclaration {
  subjectId: string;
  capability: Capability;
  variant: string | null;
  readinessProfileId: string;
  oracleProfileId: string;
  /**
   * Profile-specific required checks contributed by this approved profile
   * selection. The composed set is
   * `Capability baseline ∪ Subject × Capability additions ∪ selection checks`,
   * and the selected Oracle declaration must define every composed check.
   */
  checks: readonly string[];
}

/** Closed tolerance algorithms. Numeric comparison is valid only within one. */
export const TOLERANCE_ALGORITHMS = [
  'backing-pixel-edge',
  'css-pixel-absolute',
  'interaction-target-inset',
  'matrix-component-absolute',
] as const;
export type ToleranceAlgorithm = (typeof TOLERANCE_ALGORITHMS)[number];

export function isToleranceAlgorithm(value: unknown): value is ToleranceAlgorithm {
  return typeof value === 'string' && (TOLERANCE_ALGORITHMS as readonly string[]).includes(value);
}

/** One immutable tolerance declaration with a closed rationale and domain. */
export interface ToleranceDeclaration {
  toleranceId: string;
  version: number;
  algorithm: ToleranceAlgorithm;
  units: string;
  value: number | null;
  parameters: Readonly<Record<string, number>> | null;
  rationale: string;
  compatibilityDomain: string;
}

/** Closed visual-authority modes (four accepted modes only). */
export const VISUAL_MODES = ['bounded-capture', 'perceptual', 'semantic', 'structural'] as const;
export type VisualMode = (typeof VISUAL_MODES)[number];

export function isVisualMode(value: unknown): value is VisualMode {
  return typeof value === 'string' && (VISUAL_MODES as readonly string[]).includes(value);
}

/**
 * Closed visual algorithm domain (ADR 0024 §5). A meaning-bearing visual
 * declaration may only name an algorithm from this closed set; any other value
 * is rejected before planning. No pixel-baseline algorithm or lifecycle exists.
 */
export const VISUAL_ALGORITHMS = ['screenshot-capture-v1', 'structural-probe-v1'] as const;
export type VisualAlgorithm = (typeof VISUAL_ALGORITHMS)[number];

export function isVisualAlgorithm(value: unknown): value is VisualAlgorithm {
  return typeof value === 'string' && (VISUAL_ALGORITHMS as readonly string[]).includes(value);
}

/** Closed visual evidence-source domain (ADR 0024 §5). */
export const VISUAL_EVIDENCE_SOURCES = ['raster.accepted', 'screenshot.diagnostic'] as const;
export type VisualEvidenceSource = (typeof VISUAL_EVIDENCE_SOURCES)[number];

export function isVisualEvidenceSource(value: unknown): value is VisualEvidenceSource {
  return (
    typeof value === 'string' && (VISUAL_EVIDENCE_SOURCES as readonly string[]).includes(value)
  );
}

/** Closed visual bounded-region domain (ADR 0024 §5). */
export const VISUAL_BOUNDED_REGIONS = ['target-viewport-rect', 'viewport'] as const;
export type VisualBoundedRegion = (typeof VISUAL_BOUNDED_REGIONS)[number];

export function isVisualBoundedRegion(value: unknown): value is VisualBoundedRegion {
  return typeof value === 'string' && (VISUAL_BOUNDED_REGIONS as readonly string[]).includes(value);
}

/** Exactly two evidence roles; a third role is never introduced. */
export const VISUAL_AUTHORITY_ROLES = ['diagnostic-only', 'required-authoritative'] as const;
export type VisualAuthorityRole = (typeof VISUAL_AUTHORITY_ROLES)[number];

/**
 * One approved visual combination (ADR 0024 §5). Validation rejects any
 * (mode, algorithm, evidenceSource, authorityRole, region, tolerance class)
 * tuple that is not represented here, so an invalid combination cannot be
 * smuggled in by naming individually known discriminants.
 */
export interface VisualCombination {
  mode: VisualMode;
  algorithm: VisualAlgorithm;
  evidenceSource: VisualEvidenceSource;
  authorityRole: VisualAuthorityRole;
  boundedRegion: VisualBoundedRegion;
  /** Required tolerance algorithm, or `null` when no tolerance is permitted. */
  toleranceAlgorithm: ToleranceAlgorithm | null;
}

export const VISUAL_COMBINATIONS: readonly VisualCombination[] = Object.freeze([
  Object.freeze({
    mode: 'structural' as const,
    algorithm: 'structural-probe-v1' as const,
    evidenceSource: 'raster.accepted' as const,
    authorityRole: 'required-authoritative' as const,
    boundedRegion: 'target-viewport-rect' as const,
    toleranceAlgorithm: 'backing-pixel-edge' as const,
  }),
  Object.freeze({
    mode: 'bounded-capture' as const,
    algorithm: 'screenshot-capture-v1' as const,
    evidenceSource: 'screenshot.diagnostic' as const,
    authorityRole: 'diagnostic-only' as const,
    boundedRegion: 'viewport' as const,
    toleranceAlgorithm: null,
  }),
]);

/** One declared visual authority. P7-A introduces no governed pixel baseline. */
export interface VisualAuthorityDeclaration {
  visualId: string;
  version: number;
  mode: VisualMode;
  algorithm: VisualAlgorithm;
  evidenceSource: VisualEvidenceSource;
  authorityRole: VisualAuthorityRole;
  toleranceRef: string | null;
  boundedRegion: VisualBoundedRegion;
  currentness: readonly string[];
}

/**
 * Closed normalization applicability domain (ADR 0024 §6). A resolved route
 * that does not require normalization uses the explicit non-applicable variant
 * rather than an arbitrary string such as `"none"`.
 */
export const NORMALIZATION_APPLICABILITIES = ['frontend-serialize-restore'] as const;
export type NormalizationApplicability = (typeof NORMALIZATION_APPLICABILITIES)[number];

/** Closed normalization meaning/version domain (ADR 0024 §6). */
export const NORMALIZATION_MEANING_REFS = ['artwork-product-meaning-v1'] as const;
export type NormalizationMeaningRef = (typeof NORMALIZATION_MEANING_REFS)[number];

/** Closed normalization evaluator domain (ADR 0024 §6). */
export const NORMALIZATION_EVALUATORS = ['restore-normalization-v1'] as const;
export type NormalizationEvaluator = (typeof NORMALIZATION_EVALUATORS)[number];

/**
 * The only currently approved applicable normalization triple (ADR 0024 §6).
 * A new applicability, meaning, or evaluator domain requires a later
 * authoritative decision rather than accepting a new arbitrary string.
 */
export const NORMALIZATION_COMBINATION: Readonly<{
  applicability: NormalizationApplicability;
  meaningRef: NormalizationMeaningRef;
  evaluator: NormalizationEvaluator;
}> = Object.freeze({
  applicability: 'frontend-serialize-restore' as const,
  meaningRef: 'artwork-product-meaning-v1' as const,
  evaluator: 'restore-normalization-v1' as const,
});

/** One immutable normalization declaration (ADR 0023 §2 "Normalization"). */
export interface NormalizationDeclaration {
  normalizationId: string;
  version: number;
  applicability: NormalizationApplicability;
  /** Closed meaning/version reference (for example `artwork-product-meaning-v1`). */
  meaningRef: NormalizationMeaningRef;
  evaluator: NormalizationEvaluator;
}

/** Explicit non-applicability instead of a fabricated normalization policy. */
export interface ResolvedNormalizationNonApplicable {
  applicable: false;
}

export interface ResolvedNormalizationApplicable extends NormalizationDeclaration {
  applicable: true;
  /** Domain-separated full canonical fingerprint of the declaration. */
  fingerprint: string;
}

export type ResolvedNormalization =
  | ResolvedNormalizationApplicable
  | ResolvedNormalizationNonApplicable;

/** One resolved required-check contract in the compiled profile. */
export interface ResolvedCheckContract extends OracleCheckDeclaration {}

/** One resolved reference-closure edge. */
export interface CorrectnessReferenceEntry {
  kind: string;
  id: string;
}

/** One non-weakening assertion, all of which must hold for a profile. */
export interface NonWeakeningAssertion {
  requirement: string;
  satisfied: boolean;
  evidence: string;
}

/** Domain-separated full canonical SHA-256 component fingerprints. */
export interface CorrectnessComponentFingerprints {
  readiness: string;
  capture: string;
  oracle: string;
  capabilityBaseline: string;
  subjectAddition: string;
  requiredCheckSet: string;
  tolerances: string;
  visuals: string;
  normalization: string;
}

/**
 * One immutable, closed resolved correctness profile per delivered
 * route/profile selection. The materialization identity changes when any
 * correctness-affecting component changes; `caseId` never changes.
 */
export interface ResolvedCorrectnessProfile {
  schemaVersion: number;
  /** The selected readiness profile id (the profile-selection identity). */
  profileId: string;
  subjectId: string;
  capability: Capability;
  variant: string | null;
  readiness: ReadinessDeclaration;
  capture: CaptureDeclaration;
  oracle: OracleDeclaration;
  capabilityBaseline: CapabilityBaselineDeclaration;
  subjectAddition: SubjectAdditionDeclaration;
  requiredChecks: readonly ResolvedCheckContract[];
  requiredAuthoritativeEvidence: readonly string[];
  diagnosticOnlyEvidence: readonly string[];
  tolerances: readonly ToleranceDeclaration[];
  visuals: readonly VisualAuthorityDeclaration[];
  normalization: ResolvedNormalization;
  referenceClosure: readonly CorrectnessReferenceEntry[];
  nonWeakening: readonly NonWeakeningAssertion[];
  componentFingerprints: CorrectnessComponentFingerprints;
  /** One full canonical SHA-256 fingerprint for the resolved projection. */
  resolvedFingerprint: string;
}

/** The complete loaded correctness catalogue. */
export interface CorrectnessCatalogue {
  schemaVersion: number;
  readiness: readonly ReadinessDeclaration[];
  captures: readonly CaptureDeclaration[];
  oracles: readonly OracleDeclaration[];
  capabilityBaselines: readonly CapabilityBaselineDeclaration[];
  subjectAdditions: readonly SubjectAdditionDeclaration[];
  routeSelections: readonly RouteProfileSelectionDeclaration[];
  tolerances: readonly ToleranceDeclaration[];
  visuals: readonly VisualAuthorityDeclaration[];
  normalizations: readonly NormalizationDeclaration[];
}

/** Delivery state of one declared registry binding under the compiled contract. */
export const BINDING_CORRECTNESS_STATES = [
  'compiled-profile',
  'coverage-model-only',
  'profile-unavailable',
] as const;
export type BindingCorrectnessState = (typeof BINDING_CORRECTNESS_STATES)[number];

export interface BindingCorrectnessLedgerEntry {
  subjectId: string;
  capability: Capability;
  state: BindingCorrectnessState;
  coverageModelPresent: boolean;
  routeSelectionPresent: boolean;
  detail: string;
}
