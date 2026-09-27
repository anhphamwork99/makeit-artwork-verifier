import type { ContractVersions, ResolvedRoute } from './case-model';
import type { CoverageObligationMapping, CoverageTupleCoverage } from './coverage';
import type { DiagnosticRecord } from './diagnostics';
import type {
  Capability,
  CaseProvenance,
  CompletenessDimension,
  CompletenessStatus,
  CoverageStatus,
  EvidenceRole,
  OwnershipKind,
  OwnershipProofKind,
  PlanStatus,
} from './discriminants';

/**
 * Planner output records (decision 0007 "Planner outputs", specification 8.5).
 *
 * Every planning attempt emits these records, including rejected attempts. They
 * are produced from resolved contracts only: no report may assert coverage,
 * ownership, or authority that the attempt did not actually establish.
 */

export const PREFLIGHT_STAGE_IDS = [
  'P0',
  'P1',
  'P2',
  'P3',
  'P4',
  'P5',
  'P6',
  'P7',
  'P8',
  'P9',
  'P10',
] as const;
export type PreflightStageId = (typeof PREFLIGHT_STAGE_IDS)[number];

export const PREFLIGHT_STAGE_NAMES: Readonly<Record<PreflightStageId, string>> = {
  P0: 'parse-input',
  P1: 'load-catalogues-and-reconcile-registry',
  P2: 'normalize-intent',
  P3: 'resolve-binding',
  P4: 'materialize-coverage',
  P5: 'resolve-fixture-resources-environment',
  P6: 'route-adapter-workflow',
  P7: 'resolve-readiness-oracle-evidence',
  P8: 'compile-closed-phase-graph',
  P9: 'derive-identities',
  P10: 'preflight-and-enforceable-allocation',
};

export const PREFLIGHT_STAGE_OUTCOMES = ['deferred', 'rejected', 'resolved'] as const;
export type PreflightStageOutcome = (typeof PREFLIGHT_STAGE_OUTCOMES)[number];

export interface PreflightStageResult {
  stageId: PreflightStageId;
  name: string;
  outcome: PreflightStageOutcome;
  detail: string;
}

export interface NonWeakeningAuditEntry {
  requirement: string;
  satisfied: boolean;
  evidence: string;
}

export interface PreflightScope {
  frontendOnly: true;
  subjectId: string | null;
  capability: Capability | null;
  scenario: string | null;
  variant: string | null;
}

export interface PreflightFingerprints {
  caseId: string | null;
  materializationFingerprint: string | null;
  planFingerprint: string | null;
  registryFingerprint: string | null;
  applicationInventoryFingerprint: string | null;
  operationCatalogueFingerprint: string | null;
  adapterCatalogueFingerprint: string | null;
  workflowCatalogueFingerprint: string | null;
  /** Full canonical fingerprint of the compiled correctness profile (ADR 0023). */
  correctnessProfileFingerprint: string | null;
}

export interface PreflightReport {
  schemaVersion: number;
  status: PlanStatus;
  launchAttempted: false;
  stages: readonly PreflightStageResult[];
  resolvedContracts: ContractVersions | null;
  fingerprints: PreflightFingerprints;
  route: ResolvedRoute | null;
  nonWeakeningAudit: readonly NonWeakeningAuditEntry[];
  warnings: readonly DiagnosticRecord[];
  scope: PreflightScope;
  rejectionReasons: readonly string[];
  /**
   * Structured record for each planner rejection. The primary error is always a
   * `DiagnosticRecord`, never only a code plus a formatted string.
   */
  rejectionDiagnostics: readonly DiagnosticRecord[];
}

export interface CoverageCompletenessEntry {
  dimension: CompletenessDimension;
  status: CompletenessStatus;
  qualification: string;
}

export interface CoverageAttributionRecord {
  schemaVersion: number;
  caseId: string | null;
  subjectId: string | null;
  capability: Capability | null;
  scenario: string | null;
  variant: string | null;
  provenance: CaseProvenance | null;
  releaseCreditEligible: boolean;
  /** Explicit basis for the credit decision; never inferred from a fallback scenario. */
  releaseCreditBasis: string;
  /** Stable blocker ids that deny Release credit; empty when eligible. */
  releaseCreditBlockers: readonly string[];
  /** Obligations the requested case itself satisfies. */
  obligations: readonly string[];
  /** Representative factor assignments used by the requested case. */
  representatives: readonly string[];
  /** Resolved binding Coverage Model fingerprint, or the explicit absent fingerprint. */
  coverageModelFingerprint: string | null;
  selectionPolicyVersion: string | null;
  selectionInputFingerprint: string | null;
  selectedCaseKeys: readonly string[];
  /** Obligation → selected-case mapping for the resolved binding selection. */
  obligationMappings: readonly CoverageObligationMapping[];
  tupleCoverage: CoverageTupleCoverage | null;
  registryCoverageStatus: CoverageStatus;
  completeness: readonly CoverageCompletenessEntry[];
  warnings: readonly DiagnosticRecord[];
}

/** The coverage-specific inputs the planner resolves before assembling attribution. */
export interface CoverageAttributionInput {
  coverageModelFingerprint: string | null;
  selectionPolicyVersion: string | null;
  selectionInputFingerprint: string | null;
  selectedCaseKeys: readonly string[];
  obligations: readonly string[];
  representatives: readonly string[];
  obligationMappings: readonly CoverageObligationMapping[];
  tupleCoverage: CoverageTupleCoverage | null;
  releaseCreditEligible: boolean;
  releaseCreditBasis: string;
  releaseCreditBlockers: readonly string[];
  completeness: readonly CoverageCompletenessEntry[];
}

export interface EvidenceRequirement {
  evidenceId: string;
  role: EvidenceRole;
  checkId: string | null;
}

export interface EvidenceRequirementsManifest {
  schemaVersion: number;
  caseId: string;
  /** Selected readiness profile id, or null when no delivered profile resolved. */
  profileId: string | null;
  /** Full canonical fingerprint of the compiled correctness profile, or null. */
  resolvedCorrectnessProfileFingerprint: string | null;
  /**
   * Evidence items the compiled profile consumes, one entry per required-check ×
   * required evidence item, plus explicitly declared diagnostic-only items.
   * Evidence ids are distinct from required-check ids (ADR 0023 P7-07).
   */
  requirements: readonly EvidenceRequirement[];
  requiredAuthoritative: readonly string[];
  diagnosticOnly: readonly string[];
  /** Required authoritative check ids the compiled profile resolved. */
  checkIds: readonly string[];
}

export interface OwnershipRecord {
  ownerKind: OwnershipKind;
  bindingId: string;
  exclusive: boolean;
}

export interface OwnershipProof {
  proofKind: OwnershipProofKind;
  bindingId: string;
  exclusive: boolean;
}

export interface OwnershipCleanupManifest {
  schemaVersion: number;
  caseId: string;
  executionInstanceId: string | null;
  expectedOwners: readonly OwnershipRecord[];
  cleanupOrder: readonly OwnershipKind[];
  /** Evidence is never removed by cleanup (specification 12). */
  preserved: readonly OwnershipKind[];
  ownershipProofs: readonly OwnershipProof[];
}

export interface PlannerOutputs {
  preflightReport: PreflightReport;
  coverageAttribution: CoverageAttributionRecord;
  evidenceRequirements: EvidenceRequirementsManifest;
  ownershipCleanup: OwnershipCleanupManifest;
}
