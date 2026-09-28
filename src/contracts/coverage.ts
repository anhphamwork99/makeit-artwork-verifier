import type { DiagnosticRecord } from './diagnostics';
import type { Capability, ExecutionProfile } from './discriminants';

/**
 * Versioned Coverage Model contract (decision 0004, specification 7).
 *
 * Coverage identity is one supported `Verification Subject × Capability`
 * binding. A binding declares one canonical baseline, Factors with named
 * Equivalence Partitions and representatives, meaningful boundaries, structural
 * constraints, unsupported/not-applicable combinations, negative scenarios with
 * an explicit execution-profile eligibility, Coverage Obligations, and a
 * bounded residual-strength policy. Declarations are data only: no executable
 * selection hook, Subject-name branch, or arbitrary predicate is representable.
 */

export const COVERAGE_OBLIGATION_KINDS = [
  'baseline',
  'boundary',
  'interaction',
  'partition',
  'risk',
  'transition',
  'tuple',
] as const;
export type CoverageObligationKind = (typeof COVERAGE_OBLIGATION_KINDS)[number];

/**
 * `valid` values form the release universe; `seller-invalid` values are
 * product-invalid but seller-attemptable and are reachable only through an
 * explicit negative scenario; `unsupported` values are never generated.
 */
export const COVERAGE_PARTITION_VALIDITIES = ['seller-invalid', 'unsupported', 'valid'] as const;
export type CoveragePartitionValidity = (typeof COVERAGE_PARTITION_VALIDITIES)[number];

/** `diagnostic-only` scenarios are excluded from Release selection. */
export const COVERAGE_SCENARIO_ELIGIBILITIES = ['diagnostic-only', 'release-required'] as const;
export type CoverageScenarioEligibility = (typeof COVERAGE_SCENARIO_ELIGIBILITIES)[number];

export const COVERAGE_COMBINATION_CLASSIFICATIONS = [
  'not-applicable',
  'seller-attemptable-invalid',
  'structurally-impossible',
  'unsupported',
] as const;
export type CoverageCombinationClassification =
  (typeof COVERAGE_COMBINATION_CLASSIFICATIONS)[number];

/** Deterministic selection policy identity recorded on every selection. */
export const COVERAGE_SELECTION_POLICY_VERSION = 'coverage-selection/v1';

/** The supported default residual strength is pairwise (`t = 2`). */
export const COVERAGE_DEFAULT_RESIDUAL_STRENGTH = 2;

/** Bounded upper limit for an explicitly justified local stronger submodel. */
export const COVERAGE_MAX_RESIDUAL_STRENGTH = 4;

/**
 * Conservative declared bound on the number of Cartesian assignments a single
 * binding Coverage Model may enumerate. The largest authored model currently
 * declares a few hundred attemptable assignments, so this leaves substantial
 * headroom while guaranteeing that a malformed or adversarial declaration (for
 * example 12 Factors with 6 values each) fails closed instead of exhausting
 * memory. The bound is checked analytically from domain sizes before any
 * enumeration; it is never enforced by generating assignments and counting.
 */
export const COVERAGE_MAX_UNIVERSE_ASSIGNMENTS = 4096;

/** A concrete scalar a Factor value may carry (no objects, arrays, or undefined). */
export type CoverageScalar = string | number | boolean;

export interface CoverageFactorValue {
  /** Stable value id used by declarations and identity mapping. */
  id: string;
  /** The concrete semantic value a Case Intent may carry at the Factor path. */
  value: CoverageScalar;
  /** The Equivalence Partition this value belongs to within its Factor. */
  partition: string;
  /** True when the value is a meaningful boundary of its partition. */
  boundary: boolean;
}

export interface CoveragePartition {
  id: string;
  /** Declared value ids in this partition, sorted. */
  values: readonly string[];
  /** Canonical representative value id, always a member of `values`. */
  representative: string;
  /** Meaningful boundary value ids, always a subset of `values`. */
  boundaries: readonly string[];
  validity: CoveragePartitionValidity;
  rationale: string;
}

export interface CoverageFactor {
  id: string;
  label: string;
  /**
   * JSON Pointer into the Case Intent (RFC 6901 subset, root = the intent)
   * where a concrete override value is declared, or `null` when the Factor is
   * only declarable through the selected scenario.
   */
  path: string | null;
  /** True when a Diagnostic request may name any declared value, not only a representative. */
  allowsConcreteValues: boolean;
  /** True when the Factor participates in default residual coverage. */
  residual: boolean;
  values: readonly CoverageFactorValue[];
  partitions: readonly CoveragePartition[];
}

export interface CoverageScenario {
  id: string;
  label: string;
  description: string;
  /** Factor id → value id canonical assignment for this scenario. */
  assignments: Readonly<Record<string, string>>;
  eligibility: CoverageScenarioEligibility;
}

export interface CoverageConstraint {
  id: string;
  /** Factor id → value id assignments excluded from the valid universe. */
  exclude: Readonly<Record<string, string>>;
  rationale: string;
}

export interface CoverageUnsupportedCombination {
  id: string;
  /** Factor id → value id assignments that are never generated. */
  combination: Readonly<Record<string, string>>;
  classification: CoverageCombinationClassification;
  rationale: string;
}

export type CoverageObligationMatch =
  | { kind: 'scenario'; scenarioId: string }
  | { kind: 'partition'; factorId: string; partitionId: string }
  | { kind: 'value'; factorId: string; valueId: string }
  | { kind: 'tuple'; values: readonly CoverageTupleMember[] };

export interface CoverageTupleMember {
  factorId: string;
  valueId: string;
}

export interface CoverageObligation {
  id: string;
  kind: CoverageObligationKind;
  description: string;
  /**
   * `release` obligations are mandatory for both profiles; `diagnostic`
   * obligations are diagnostic expansion only and never establish release
   * coverage.
   */
  requiredFor: ExecutionProfile;
  match: CoverageObligationMatch;
}

export interface CoverageResidualSubmodel {
  id: string;
  strength: number;
  factors: readonly string[];
  rationale: string;
}

/**
 * Closed residual-policy vocabulary. `constrained` is the supported default
 * (pairwise, plus any bounded stronger submodels). `not-applicable` is the only
 * sanctioned way for a multi-factor model to opt out of residual coverage, and
 * it must carry a non-empty rationale; the ambiguity is explicit and versioned
 * rather than a silent omission of `residual` Factors.
 */
export const COVERAGE_RESIDUAL_POLICY_KINDS = ['constrained', 'not-applicable'] as const;
export type CoverageResidualPolicyKind = (typeof COVERAGE_RESIDUAL_POLICY_KINDS)[number];

export interface CoverageResidualPolicy {
  policy: CoverageResidualPolicyKind;
  defaultStrength: number;
  submodels: readonly CoverageResidualSubmodel[];
  /** Non-empty justification; mandatory when `policy` is `not-applicable`. */
  rationale: string;
}

export interface BindingCoverageModel {
  subjectId: string;
  capability: Capability;
  baselineScenarioId: string;
  factors: readonly CoverageFactor[];
  scenarios: readonly CoverageScenario[];
  constraints: readonly CoverageConstraint[];
  unsupported: readonly CoverageUnsupportedCombination[];
  obligations: readonly CoverageObligation[];
  residual: CoverageResidualPolicy;
}

export interface CoverageModelCatalogue {
  schemaVersion: number;
  models: readonly BindingCoverageModel[];
}

// ── Deterministic selection records ──────────────────────────────────────────

export const SELECTED_COVERAGE_CASE_ORIGINS = [
  'baseline',
  'boundary',
  'mandatory',
  'partition',
  'residual',
] as const;
export type SelectedCoverageCaseOrigin = (typeof SELECTED_COVERAGE_CASE_ORIGINS)[number];

/**
 * Explicit, closed basis for a selected case's Release eligibility. A case may
 * never inherit eligibility by being attributed to a fallback scenario it does
 * not actually match.
 */
export const SELECTED_COVERAGE_RELEASE_BASES = [
  'declared-diagnostic-scenario',
  'declared-release-scenario',
  'non-scenario-diagnostic-assignment',
  'non-scenario-release-assignment',
] as const;
export type SelectedCoverageReleaseBasis = (typeof SELECTED_COVERAGE_RELEASE_BASES)[number];

export interface SelectedCoverageCase {
  /** Stable selection-entry key; a generated case is evidence, not a coverage identity. */
  caseKey: string;
  origin: SelectedCoverageCaseOrigin;
  /**
   * Declared scenario this case exactly matches, or `null` when the case was
   * generated from a partition, boundary, tuple, or residual requirement and
   * matches no declared scenario. A generated case is never attributed to the
   * baseline scenario.
   */
  scenarioId: string | null;
  /** Factor id → value id assignment for this selected case. */
  assignments: Readonly<Record<string, string>>;
  representativeIds: readonly string[];
  obligationIds: readonly string[];
  releaseEligible: boolean;
  /** Explicit basis that establishes (or denies) the Release eligibility above. */
  releaseBasis: SelectedCoverageReleaseBasis;
}

export interface CoverageObligationMapping {
  obligationId: string;
  kind: CoverageObligationKind;
  requiredFor: ExecutionProfile;
  caseKeys: readonly string[];
  satisfied: boolean;
}

/**
 * One reported tuple-coverage level. The default pairwise model and each
 * declared bounded stronger submodel are accounted separately, so 3-wise tuples
 * are never aggregated into a `strength: 2` record.
 */
export interface CoverageTupleLevel {
  /** `null` for the default pairwise level; otherwise the declared submodel id. */
  submodelId: string | null;
  /** The Factor ids this level covers, sorted. */
  factors: readonly string[];
  strength: number;
  required: number;
  covered: number;
  /** Canonical tuple ids that remain uncovered, sorted. */
  uncovered: readonly string[];
}

export interface CoverageTupleCoverage {
  /** The default pairwise residual model (`t = 2`). */
  pairwise: CoverageTupleLevel;
  /** One entry per declared bounded stronger submodel, ordered by submodel id. */
  submodels: readonly CoverageTupleLevel[];
}

export interface CoverageSelection {
  schemaVersion: number;
  policyVersion: string;
  /**
   * Reproduction seed. This selector performs deterministic exhaustive greedy
   * selection and no sampling, so it always records `null`; a caller-provided
   * seed is not yet part of selection identity and does not change the result.
   */
  seed: number | null;
  profile: ExecutionProfile;
  /** Fingerprint of the validated selection input (model, policy, profile). */
  inputFingerprint: string;
  coverageModelFingerprint: string;
  cases: readonly SelectedCoverageCase[];
  obligationMappings: readonly CoverageObligationMapping[];
  tupleCoverage: CoverageTupleCoverage;
  uncoveredObligations: readonly string[];
  warnings: readonly DiagnosticRecord[];
}
