import type { ContractVersions, ResolvedRoute } from '../contracts/case-model';
import type { DiagnosticRecord } from '../contracts/diagnostics';
import type {
  CaseProvenance,
  CoverageStatus,
  ExecutionProfile,
  PlanStatus,
} from '../contracts/discriminants';
import type {
  CoverageAttributionInput,
  CoverageAttributionRecord,
  EvidenceRequirement,
  EvidenceRequirementsManifest,
  NonWeakeningAuditEntry,
  OwnershipCleanupManifest,
  PlannerOutputs,
  PreflightFingerprints,
  PreflightReport,
  PreflightScope,
  PreflightStageId,
  PreflightStageOutcome,
  PreflightStageResult,
} from '../contracts/planner-outputs';
import type { ResolvedCorrectnessProfile } from '../contracts/correctness';
import { PREFLIGHT_STAGE_NAMES, PREFLIGHT_STAGE_IDS } from '../contracts/planner-outputs';
import {
  COVERAGE_ATTRIBUTION_SCHEMA_VERSION,
  EVIDENCE_REQUIREMENTS_SCHEMA_VERSION,
  PREFLIGHT_REPORT_SCHEMA_VERSION,
} from '../contracts/schema-versions';

/**
 * Preflight reporting and planner output records (decision 0007 "Planner
 * stages" and "Planner outputs").
 *
 * The tracker records every stage the attempt actually reached. Stages whose
 * contract is owned by a later Work Package are reported as `deferred` — never
 * as resolved — and stages after a rejection are reported as deferred as well.
 * That keeps a report from implying coverage, ownership, or authority the
 * attempt did not establish.
 */

export class PreflightTracker {
  private readonly recorded = new Map<PreflightStageId, PreflightStageResult>();
  private readonly rejectionDiagnostics: DiagnosticRecord[] = [];

  record(stageId: PreflightStageId, outcome: PreflightStageOutcome, detail: string): void {
    this.recorded.set(stageId, {
      stageId,
      name: PREFLIGHT_STAGE_NAMES[stageId],
      outcome,
      detail,
    });
  }

  reject(diagnostic: DiagnosticRecord): void {
    this.rejectionDiagnostics.push(diagnostic);
  }

  rejections(): readonly string[] {
    return this.rejectionDiagnostics.map((record) => `${record.code}: ${record.detail}`);
  }

  rejectionDiagnosticRecords(): readonly DiagnosticRecord[] {
    return [...this.rejectionDiagnostics];
  }

  stageOutcome(stageId: PreflightStageId): PreflightStageOutcome | null {
    return this.recorded.get(stageId)?.outcome ?? null;
  }

  stages(): PreflightStageResult[] {
    return PREFLIGHT_STAGE_IDS.map((stageId) => {
      const recordedStage = this.recorded.get(stageId);
      if (recordedStage) return recordedStage;
      return {
        stageId,
        name: PREFLIGHT_STAGE_NAMES[stageId],
        outcome: 'deferred',
        detail:
          this.rejectionDiagnostics.length > 0
            ? 'Not evaluated: the attempt was rejected before this stage.'
            : 'Not evaluated: contract owned by a later Work Package.',
      };
    });
  }
}

/** Non-weakening checks that must hold for a planned attempt to be launchable. */
const NON_WEAKENING_REQUIREMENTS = [
  {
    stageId: 'P0',
    requirement: 'closed case-request contract rejects behavior and policy overrides',
    evidence: 'P0 parse-input',
  },
  {
    stageId: 'P1',
    requirement:
      'application registry reconciled against the current application-kind inventory before binding resolution',
    evidence: 'P1 load-catalogues-and-reconcile-registry',
  },
  {
    stageId: 'P3',
    requirement: 'Capability binding, adapter and variant policy resolved from declarations only',
    evidence: 'P3 resolve-binding',
  },
  {
    stageId: 'P6',
    requirement:
      'one adapter selected per Subject, never per case, Capability, scenario or variant',
    evidence: 'P6 route-adapter-workflow',
  },
  {
    stageId: 'P8',
    requirement: 'immutable closed phase graph of approved operation discriminants',
    evidence: 'P8 compile-closed-phase-graph',
  },
  {
    stageId: 'P9',
    requirement: 'domain-separated identities derived before any launch attempt',
    evidence: 'P9 derive-identities',
  },
  {
    stageId: 'P9',
    requirement: 'ephemeral allocation excluded from the plan fingerprint',
    evidence: 'P9 planFingerprint covers the closed graph only',
  },
] as const satisfies readonly {
  stageId: PreflightStageId;
  requirement: string;
  evidence: string;
}[];

export interface PreflightReportInput {
  tracker: PreflightTracker;
  status: PlanStatus;
  scope: PreflightScope;
  warnings: readonly DiagnosticRecord[];
  caseId: string | null;
  materializationFingerprint: string | null;
  planFingerprint: string | null;
  fingerprints: {
    registryFingerprint: string | null;
    applicationInventoryFingerprint: string | null;
    operationCatalogueFingerprint: string | null;
    adapterCatalogueFingerprint: string | null;
    workflowCatalogueFingerprint: string | null;
    correctnessProfileFingerprint: string | null;
  };
  resolvedContracts: ContractVersions | null;
  route: ResolvedRoute | null;
}

export interface PlannerOutputsInput extends PreflightReportInput {
  coverageStatus: CoverageStatus;
  provenance: CaseProvenance;
  profile: ExecutionProfile;
  caseId: string;
  route: ResolvedRoute;
  resolvedContracts: ContractVersions;
  materializationFingerprint: string;
  planFingerprint: string;
  fingerprints: {
    registryFingerprint: string;
    applicationInventoryFingerprint: string;
    operationCatalogueFingerprint: string;
    adapterCatalogueFingerprint: string;
    workflowCatalogueFingerprint: string;
    correctnessProfileFingerprint: string;
  };
  requiredChecks: readonly string[];
  /** The compiled correctness profile, or null for an undelivered binding. */
  correctnessProfile: ResolvedCorrectnessProfile | null;
  ownershipCleanup: OwnershipCleanupManifest;
  coverage: CoverageAttributionInput;
}

export function buildNonWeakeningAudit(tracker: PreflightTracker): NonWeakeningAuditEntry[] {
  return NON_WEAKENING_REQUIREMENTS.map((entry) => ({
    requirement: entry.requirement,
    satisfied: tracker.stageOutcome(entry.stageId) === 'resolved',
    evidence: entry.evidence,
  }));
}

export function buildPreflightReport(input: PreflightReportInput): PreflightReport {
  const fingerprints: PreflightFingerprints = {
    caseId: input.caseId,
    materializationFingerprint: input.materializationFingerprint,
    planFingerprint: input.planFingerprint,
    registryFingerprint: input.fingerprints.registryFingerprint,
    applicationInventoryFingerprint: input.fingerprints.applicationInventoryFingerprint,
    operationCatalogueFingerprint: input.fingerprints.operationCatalogueFingerprint,
    adapterCatalogueFingerprint: input.fingerprints.adapterCatalogueFingerprint,
    workflowCatalogueFingerprint: input.fingerprints.workflowCatalogueFingerprint,
    correctnessProfileFingerprint: input.fingerprints.correctnessProfileFingerprint,
  };

  return {
    schemaVersion: PREFLIGHT_REPORT_SCHEMA_VERSION,
    status: input.status,
    launchAttempted: false,
    stages: input.tracker.stages(),
    resolvedContracts: input.resolvedContracts,
    fingerprints,
    route: input.route,
    nonWeakeningAudit: buildNonWeakeningAudit(input.tracker),
    warnings: [...input.warnings],
    scope: { ...input.scope },
    rejectionReasons: input.tracker.rejections(),
    rejectionDiagnostics: input.tracker.rejectionDiagnosticRecords(),
  };
}

/**
 * A rejected attempt keeps the stages it already resolved and records the
 * rejection on the failing stage without inventing later progress.
 */
export function rejectPreflightReport(
  report: PreflightReport,
  stageId: PreflightStageId,
  reasonCode: string,
  detail: string,
  status: PlanStatus,
  diagnostic?: DiagnosticRecord,
): PreflightReport {
  return {
    ...report,
    status,
    stages: report.stages.map((stage) =>
      stage.stageId === stageId
        ? { ...stage, outcome: 'rejected' as PreflightStageOutcome, detail }
        : stage,
    ),
    rejectionReasons: [...report.rejectionReasons, `${reasonCode}: ${detail}`],
    rejectionDiagnostics: diagnostic
      ? [...report.rejectionDiagnostics, diagnostic]
      : [...report.rejectionDiagnostics],
  };
}

/** Records that a deferred stage completed for this attempt. */
export function resolvePreflightStage(
  report: PreflightReport,
  stageId: PreflightStageId,
  detail: string,
): PreflightReport {
  return {
    ...report,
    stages: report.stages.map((stage) =>
      stage.stageId === stageId
        ? { ...stage, outcome: 'resolved' as PreflightStageOutcome, detail }
        : stage,
    ),
  };
}

export function buildCoverageAttribution(input: PlannerOutputsInput): CoverageAttributionRecord {
  return {
    schemaVersion: COVERAGE_ATTRIBUTION_SCHEMA_VERSION,
    caseId: input.caseId,
    subjectId: input.scope.subjectId,
    capability: input.scope.capability,
    scenario: input.scope.scenario,
    variant: input.scope.variant,
    provenance: input.provenance,
    releaseCreditEligible: input.coverage.releaseCreditEligible,
    releaseCreditBasis: input.coverage.releaseCreditBasis,
    releaseCreditBlockers: [...input.coverage.releaseCreditBlockers],
    obligations: [...input.coverage.obligations],
    representatives: [...input.coverage.representatives],
    coverageModelFingerprint: input.coverage.coverageModelFingerprint,
    selectionPolicyVersion: input.coverage.selectionPolicyVersion,
    selectionInputFingerprint: input.coverage.selectionInputFingerprint,
    selectedCaseKeys: [...input.coverage.selectedCaseKeys],
    obligationMappings: [...input.coverage.obligationMappings],
    tupleCoverage: input.coverage.tupleCoverage,
    registryCoverageStatus: input.coverageStatus,
    completeness: [...input.coverage.completeness],
    warnings: [...input.warnings],
  };
}

export function buildEvidenceRequirements(input: {
  caseId: string;
  requiredChecks: readonly string[];
  correctnessProfile: ResolvedCorrectnessProfile | null;
}): EvidenceRequirementsManifest {
  const profile = input.correctnessProfile;
  if (profile === null) {
    // Undelivered binding: no compiled profile resolved, so the manifest records
    // the declared required checks as the planning surface only. It is never
    // assembled for a launchable delivered route.
    const requirements: EvidenceRequirement[] = [...input.requiredChecks]
      .sort()
      .map((checkId) => ({ evidenceId: checkId, role: 'required-authoritative', checkId }));
    return {
      schemaVersion: EVIDENCE_REQUIREMENTS_SCHEMA_VERSION,
      caseId: input.caseId,
      profileId: null,
      resolvedCorrectnessProfileFingerprint: null,
      requirements,
      requiredAuthoritative: requirements.map((entry) => entry.evidenceId),
      diagnosticOnly: [],
      checkIds: [...input.requiredChecks].sort(),
    };
  }

  const requirements: EvidenceRequirement[] = [];
  for (const check of profile.requiredChecks) {
    for (const evidenceId of [...check.requiredEvidence].sort()) {
      requirements.push({ evidenceId, role: 'required-authoritative', checkId: check.checkId });
    }
  }
  for (const evidenceId of [...profile.diagnosticOnlyEvidence].sort()) {
    requirements.push({ evidenceId, role: 'diagnostic-only', checkId: null });
  }
  requirements.sort((left, right) => {
    if (left.role !== right.role) return left.role < right.role ? -1 : 1;
    if (left.evidenceId !== right.evidenceId) return left.evidenceId < right.evidenceId ? -1 : 1;
    return (left.checkId ?? '') < (right.checkId ?? '') ? -1 : 1;
  });

  return {
    schemaVersion: EVIDENCE_REQUIREMENTS_SCHEMA_VERSION,
    caseId: input.caseId,
    profileId: profile.profileId,
    resolvedCorrectnessProfileFingerprint: profile.resolvedFingerprint,
    requirements,
    requiredAuthoritative: [...profile.requiredAuthoritativeEvidence],
    diagnosticOnly: [...profile.diagnosticOnlyEvidence],
    checkIds: profile.requiredChecks.map((check) => check.checkId),
  };
}

export function buildPlannerOutputs(input: PlannerOutputsInput): PlannerOutputs {
  return {
    preflightReport: buildPreflightReport(input),
    coverageAttribution: buildCoverageAttribution(input),
    evidenceRequirements: buildEvidenceRequirements({
      caseId: input.caseId,
      requiredChecks: input.requiredChecks,
      correctnessProfile: input.correctnessProfile,
    }),
    ownershipCleanup: input.ownershipCleanup,
  };
}
