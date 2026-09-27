import type { AdapterDeclaration } from './catalogues';
import type { DiagnosticCode, DiagnosticRecord } from './diagnostics';
import type {
  AllocationFailureReason,
  Capability,
  CaseProvenance,
  CoverageStatus,
  EvidenceDepth,
  ExecutionProfile,
  PlanPhaseName,
  SubjectFamily,
  SubjectOrigin,
} from './discriminants';
import type { ExecutionAllocation } from './execution';
import type { PlannerOutputs } from './planner-outputs';

/**
 * Case model contracts (decision 0007).
 *
 * `CaseRequest`/`CaseIntent` carry only semantic intent. Provenance, profile,
 * release credit and evidence depth live on the request and never enter
 * `caseId`. The materialized case, executable plan, and planner outputs are
 * immutable complete resolutions of that intent.
 */

export interface SemanticResourceRef {
  resourceId: string;
  contentDigest: string;
}

export interface CaseIntentOperation {
  discriminant: string;
  parameters: Readonly<Record<string, unknown>>;
}

export interface CaseIntent {
  subjectId: string;
  capability: Capability;
  variant: string | null;
  scenario: string;
  preState: Readonly<Record<string, unknown>>;
  /** Operation order is meaningful: it is the ordered action sequence. */
  operations: readonly CaseIntentOperation[];
  expected: Readonly<Record<string, unknown>>;
  resources: readonly SemanticResourceRef[];
}

export interface CaseRequest {
  schemaVersion: number;
  profile: ExecutionProfile;
  provenance: CaseProvenance;
  evidenceDepth: EvidenceDepth;
  intent: CaseIntent;
}

export interface ContractVersions {
  subjectCatalogueSchemaVersion: number;
  registryFingerprint: string;
  applicationInventoryFingerprint: string;
  operationCatalogueFingerprint: string;
  adapterCatalogueFingerprint: string;
  workflowCatalogueFingerprint: string;
  familyDefaultVersion: number;
  adapterCompatibilityVersion: number;
  workflowVersion: number;
  coverageModelFingerprint: string;
  /**
   * Full canonical fingerprint of the compiled `ResolvedCorrectnessProfile` for
   * this delivered route (ADR 0023 §3), or the explicit absent-profile identity
   * for an undelivered binding. Our correctness-affecting component change must
   * move the materialization identity.
   */
  correctnessProfileFingerprint: string;
}

export interface MaterializedSubject {
  subjectId: string;
  family: SubjectFamily;
  origin: SubjectOrigin;
  applicationKind: string | null;
  adapter: AdapterDeclaration;
}

export interface ResolvedRoute {
  subjectId: string;
  adapterId: string;
  adapterCompatibilityVersion: number;
  workflowId: string;
  capability: Capability;
  checks: readonly string[];
}

export interface ResolvedFixtureBinding {
  fixtureId: string;
  constructorId: string;
  constructorVersion: number;
  /** Canonical fingerprint of the exact declared constructor inputs. */
  inputsFingerprint: string;
  /**
   * Canonical fingerprint of the complete declared semantic target-role
   * contract (role names, kinds, layout roles, resolution timing, and declared
   * geometry/semantic profiles). Role-timing changes must move the
   * materialization and plan identity even when the requested product meaning
   * and pre-state are unchanged (ADR 0018 CR4).
   */
  targetRoleContractFingerprint: string;
  /** The complete declared role contract carried by the immutable plan. */
  semanticTargetRoles: readonly import('./adapter').SemanticTargetRole[];
  /**
   * Immutable fingerprint of the accepted generated-Crossword product source
   * contract (ADR 0017 R4), present only when the resolved role contract
   * declares a generated Crossword semantic profile. Materialization binds it
   * into `materializationFingerprint`/`planFingerprint`; the generated drive
   * recomputes the live fingerprint and fails closed on any drift instead of
   * re-baselining on a changed product revision.
   */
  crosswordSourceFingerprint?: string;
}

export interface MaterializedCase {
  schemaVersion: number;
  caseId: string;
  intent: CaseIntent;
  subject: MaterializedSubject;
  route: ResolvedRoute;
  contracts: ContractVersions;
  /**
   * The resolved fixture binding. Fixture frame literals are semantic pre-state
   * (ADR 0013), so this participates in the materialization identity and in
   * `caseId`; a fixture/constructor pre-state migration must never reuse the
   * old case identity (ADR 0015 B16).
   */
  fixture?: ResolvedFixtureBinding;
}

export interface PlanPhase {
  phase: PlanPhaseName;
  operations: readonly string[];
}

export interface ExecutionPlan {
  schemaVersion: number;
  caseId: string;
  route: ResolvedRoute;
  phases: readonly PlanPhase[];
  requiredChecks: readonly string[];
  /** Mandatory removal operations; evidence preservation is declared separately. */
  cleanup: readonly string[];
  /**
   * The compiled correctness projection identity (ADR 0023 §3). `planFingerprint`
   * reflects this closed projection and continues to exclude ephemeral
   * allocation.
   */
  correctness: PlanCorrectnessIdentity;
  /** The resolved fixture binding; see `MaterializedCase.fixture`. */
  fixture?: ResolvedFixtureBinding;
}

export interface PlanCorrectnessIdentity {
  profileId: string | null;
  resolvedFingerprint: string;
}

export interface CorrectnessProjection {
  caseId: string;
  intent: CaseIntent;
  route: ResolvedRoute;
  requiredChecks: readonly string[];
}

export interface PlannedPlan {
  status: 'PLANNED';
  launchAttempted: false;
  caseId: string;
  materializationFingerprint: string;
  planFingerprint: string;
  request: CaseRequest;
  materializedCase: MaterializedCase;
  plan: ExecutionPlan;
  outputs: PlannerOutputs;
  coverageStatus: CoverageStatus;
  findings: readonly DiagnosticRecord[];
}

export interface BlockedPlan {
  status: 'HARNESS_BLOCKED';
  launchAttempted: false;
  code: DiagnosticCode;
  /** Structured record for the primary rejection reason. */
  diagnostic: DiagnosticRecord;
  findings: readonly DiagnosticRecord[];
  report: PlannerOutputs['preflightReport'];
}

export interface EnvironmentBlockedPlan {
  status: 'ENVIRONMENT_FAILURE';
  launchAttempted: false;
  reason: AllocationFailureReason;
  findings: readonly DiagnosticRecord[];
  report: PlannerOutputs['preflightReport'];
}

export type PlanResult = PlannedPlan | BlockedPlan | EnvironmentBlockedPlan;

/** A planned case whose exclusive launch resources were reserved before launch. */
export type ReservedPlanResult =
  | (PlannedPlan & { allocation: ExecutionAllocation })
  | BlockedPlan
  | EnvironmentBlockedPlan;
